/* ============================================================================
 * ███ FEED.JS ███
 * MyCitadel — Aggregated timeline (with media attachments)
 * ========================================================================== */

(function () {
    'use strict';

    const root = document.querySelector('.feed-root');
    if (!root) return;

    const API_BASE  = root.dataset.apiBase  || 'https://api.mycitadel.lol/v1';
    const CLIENT    = root.dataset.client   || 'browser/1.0.0';
    const LOGIN_URL = root.dataset.loginUrl || '/login';

    const DEFAULT_AVATAR    = 'https://mycitadel.lol/img/users/default/avatar.png';
    const MAX_ATTACHMENTS   = 6;

    /* ── DOM refs ──────────────────────────────────────────────────── */
    const loadingEl      = document.getElementById('feed-loading');
    const errorEl        = document.getElementById('feed-error');
    const errorMsgEl     = document.getElementById('feed-error-msg');
    const retryBtn       = document.getElementById('feed-retry');
    const shellEl        = document.getElementById('feed-shell');
    const listEl         = document.getElementById('feed-list');
    const emptyEl        = document.getElementById('feed-empty');
    const moreEl         = document.getElementById('feed-more');
    const moreBtn        = document.getElementById('feed-more-btn');
    const toastLayer     = document.getElementById('feed-toast-layer');
    const composerText   = document.getElementById('composer-text');
    const composerCount  = document.getElementById('composer-count');
    const composerSubmit = document.getElementById('composer-submit');
    const composerAvatar = document.getElementById('composer-avatar');
    const attachBtn      = document.getElementById('composer-attach');
    const attachInput    = document.getElementById('composer-file-input');
    const attachList     = document.getElementById('composer-attachments');

    /* ── Runtime state ─────────────────────────────────────────────── */
    let currentUser        = null;
    let scope              = 'all';
    let nextCursor         = null;
    let loadingMore        = false;
    let visibility         = 'public';
    let wired              = false;
    let csrfToken          = null;
    let csrfPromise        = null;
    let pendingAttachments = [];   // [{token, url, kind, mime, name, size}]

    const log  = (...a) => console.log('[feed]', ...a);
    const warn = (...a) => console.warn('[feed]', ...a);
    const err  = (...a) => console.error('[feed]', ...a);

    /* ══════════════════════════════════════════════════════════════════
     * UTILITIES
     * ================================================================ */

    function esc(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function fmtRelative(iso) {
        if (!iso) return '—';
        const diff = (Date.now() - new Date(iso).getTime()) / 1000;
        if (diff < 60)     return 'just now';
        if (diff < 3600)   return Math.floor(diff / 60) + 'm';
        if (diff < 86400)  return Math.floor(diff / 3600) + 'h';
        if (diff < 604800) return Math.floor(diff / 86400) + 'd';
        return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }

    function fmtFullDate(iso) {
        if (!iso) return '';
        return new Date(iso).toLocaleString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric',
            hour: 'numeric', minute: '2-digit'
        });
    }

    function initialsOf(name) {
        if (!name) return '?';
        const parts = String(name).trim().split(/\s+/);
        if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
        return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }

    function visibilityIcon(v) {
        return ({ public: '🌐', connections: '⚔', private: '🔒' })[v] || '🌐';
    }

    function formatBytes(n) {
        if (!n) return '0 B';
        if (n < 1024) return n + ' B';
        if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
        if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
        return (n / 1073741824).toFixed(2) + ' GB';
    }

    function fileIcon(mime) {
        if (!mime) return '📎';
        if (mime.startsWith('video/')) return '🎬';
        if (mime.startsWith('audio/')) return '🎵';
        if (mime === 'application/pdf') return '📄';
        if (mime === 'application/zip') return '🗜';
        return '📎';
    }

    /**
     * Resolve an avatar URL from a post/comment/user object.
     * Different API responses use different field names — check them all.
     * Falls back to the DEFAULT_AVATAR image so we never show a blank.
     */
    function resolveAvatar(source) {
        if (!source) return DEFAULT_AVATAR;
        const candidates = [
            source.author_avatar_url,
            source.avatar_url,
            source.user_avatar_url,
            source.avatarUrl,
        ];
        for (const c of candidates) {
            if (typeof c === 'string' && c.length > 0) return c;
        }
        return DEFAULT_AVATAR;
    }

    function toast(msg, kind = 'info', ms = 2600) {
        if (!toastLayer) return;
        const el = document.createElement('div');
        el.className = 'feed-toast feed-toast--' + kind;
        el.textContent = msg;
        toastLayer.appendChild(el);
        requestAnimationFrame(() => el.classList.add('is-visible'));
        setTimeout(() => {
            el.classList.remove('is-visible');
            setTimeout(() => el.remove(), 220);
        }, ms);
    }

    /* ══════════════════════════════════════════════════════════════════
     * CSRF
     * ================================================================ */

    function citadelCsrf() {
        try {
            if (window.Citadel && typeof window.Citadel.getCsrf === 'function') {
                const t = window.Citadel.getCsrf();
                return t && typeof t === 'string' ? t : null;
            }
        } catch (_) {}
        return null;
    }

    async function mintCsrf() {
        if (csrfToken) return csrfToken;
        if (csrfPromise) return csrfPromise;

        const citadelToken = citadelCsrf();
        if (citadelToken) {
            csrfToken = citadelToken;
            return csrfToken;
        }

        csrfPromise = (async () => {
            try {
                const res = await fetch(API_BASE + '/auth/csrf.php', {
                    credentials: 'include',
                    headers: { 'X-Citadel-Client': CLIENT },
                });
                if (!res.ok) return null;
                const data = await res.json();
                if (data && data.status === 'ok' && data.token) {
                    csrfToken = data.token;
                    return csrfToken;
                }
            } catch (e) { warn('CSRF mint failed', e); }
            csrfPromise = null;
            return null;
        })();

        return csrfPromise;
    }

    /* ══════════════════════════════════════════════════════════════════
     * API
     * ================================================================ */

    async function api(method, path, body) {
        const headers = { 'X-Citadel-Client': CLIENT };
        const isUnsafe = method !== 'GET' && method !== 'HEAD';
        const hasBody = body !== undefined && body !== null;

        if (hasBody) headers['Content-Type'] = 'application/json';

        if (isUnsafe) {
            const t = await mintCsrf();
            if (!t) throw makeError('csrf_failed', 'Could not establish a secure session.');
            headers['X-CSRF-Token'] = t;
        }

        let res;
        try {
            res = await fetch(API_BASE + path, {
                method, credentials: 'include', headers,
                body: hasBody ? JSON.stringify(body) : undefined,
            });
        } catch (e) {
            throw makeError('network_error', 'Network error: ' + (e.message || 'unknown'));
        }

        let data = null;
        try { data = await res.json(); } catch (_) {}

        if (data && typeof data.csrf_token === 'string' && data.csrf_token.length > 0) {
            csrfToken = data.csrf_token;
        }

        if (res.status === 401) {
            const next = encodeURIComponent(location.pathname + location.search);
            window.location.href = `${LOGIN_URL}?next=${next}`;
            throw makeError('unauthenticated', 'Session expired.');
        }

        if (!res.ok) {
            throw makeError(
                (data && data.code) || ('http_' + res.status),
                (data && data.message) || ('Request failed: ' + res.status)
            );
        }

        if (!data || data.status === 'error') {
            throw makeError(
                (data && data.code) || 'unknown',
                (data && data.message) || 'Unexpected response from server.'
            );
        }

        return data;
    }

    function makeError(code, message) {
        const e = new Error(message);
        e.code = code;
        return e;
    }

    /* ══════════════════════════════════════════════════════════════════
     * RESOLVE CURRENT USER
     * ================================================================ */

    async function resolveCurrentUser() {
        try {
            if (window.Citadel && window.Citadel.user) return window.Citadel.user;
        } catch (_) {}

        const userFromEvent = await waitForCitadelEvent(2500);
        if (userFromEvent) return userFromEvent;

        try {
            const data = await api('GET', '/users/me.php');
            if (data && data.user) return data.user;
        } catch (e) {
            if (e.code === 'unauthenticated') throw e;
            warn('own /users/me.php failed:', e.message);
        }

        return null;
    }

    function waitForCitadelEvent(timeoutMs) {
        return new Promise((resolve) => {
            if (!window.addEventListener) return resolve(null);
            if (window.Citadel && window.Citadel.user) return resolve(window.Citadel.user);

            let settled = false;
            const onReady = (e) => {
                if (settled) return;
                settled = true;
                window.removeEventListener('citadel:ready', onReady);
                resolve((e && e.detail && e.detail.user) || null);
            };
            window.addEventListener('citadel:ready', onReady, { once: true });
            setTimeout(() => {
                if (settled) return;
                settled = true;
                window.removeEventListener('citadel:ready', onReady);
                resolve((window.Citadel && window.Citadel.user) || null);
            }, timeoutMs);
        });
    }

    /* ══════════════════════════════════════════════════════════════════
     * IDENTITY CARD
     * ================================================================ */

    function renderIdentity(user) {
        const avatarUrl  = resolveAvatar(user);
        const initials   = initialsOf(user.display_name || user.username);
        const avatarHtml = `<img src="${esc(avatarUrl)}" alt="${esc(user.username)}"
                                 onerror="this.replaceWith(document.createTextNode('${esc(initials)}'))">`;

        const identityEl = document.getElementById('feed-identity-card');
        if (identityEl) {
            identityEl.innerHTML = `
                <div class="feed-identity">
                    <div class="feed-identity__avatar">${avatarHtml}</div>
                    <div class="feed-identity__meta">
                        <p class="feed-identity__name">${esc(user.display_name || user.username)}</p>
                        <p class="feed-identity__handle">@${esc(user.username)}</p>
                    </div>
                </div>
                <a href="/users/dashboard.php" class="feed-identity__link">View Dashboard →</a>
            `;
        }

        if (composerAvatar) {
            composerAvatar.innerHTML = `<img src="${esc(avatarUrl)}" alt="">`;
        }
    }

    /* ══════════════════════════════════════════════════════════════════
     * ATTACHMENT RENDERING
     * ================================================================ */

    function renderAttachments(list) {
        if (!Array.isArray(list) || list.length === 0) return '';

        const n = list.length;
        const gridClass = n === 1 ? 'att-grid att-grid--1'
                        : n === 2 ? 'att-grid att-grid--2'
                        : n === 3 ? 'att-grid att-grid--3'
                        : n === 4 ? 'att-grid att-grid--4'
                                  : 'att-grid att-grid--many';

        const items = list.map((a, i) => {
            if (a.kind === 'image') {
                return `<a href="${esc(a.url)}" target="_blank" rel="noopener"
                           class="att att--image" data-att="${i}">
                    <img src="${esc(a.url)}" alt="" loading="lazy">
                </a>`;
            }
            if (a.kind === 'video') {
                return `<video class="att att--video" controls preload="metadata">
                    <source src="${esc(a.url)}" type="${esc(a.mime)}">
                </video>`;
            }
            if (a.kind === 'audio') {
                return `<div class="att att--audio">
                    <span class="att__icon">🎵</span>
                    <audio controls src="${esc(a.url)}"></audio>
                </div>`;
            }
            return `<a href="${esc(a.url)}" class="att att--file" download>
                <span class="att__icon">${fileIcon(a.mime)}</span>
                <span class="att__name">${esc(a.name || 'File')}</span>
                <span class="att__size">${formatBytes(a.size)}</span>
            </a>`;
        }).join('');

        return `<div class="${gridClass}">${items}</div>`;
    }

    /* ══════════════════════════════════════════════════════════════════
     * POST CARD
     * ================================================================ */

    function renderPost(p) {
        const isOwn   = currentUser && p.user_id === currentUser.id;
        const visIcon = visibilityIcon(p.visibility);

        const card = document.createElement('article');
        card.className = 'post';
        card.dataset.postId = p.id;

        const avatarUrl  = resolveAvatar(p);
        const initials   = initialsOf(p.author_display_name || p.author_username);
        const avatarHtml = `<img src="${esc(avatarUrl)}" alt=""
                                 onerror="this.src='${esc(DEFAULT_AVATAR)}'">`;

        card.innerHTML = `
            <header class="post__head">
                <a href="/users/view.php?id=${p.user_id}" class="post__avatar">${avatarHtml}</a>
                <div class="post__who">
                    <a href="/users/view.php?id=${p.user_id}" class="post__name">
                        ${esc(p.author_display_name || p.author_username)}
                    </a>
                    <div class="post__meta">
                        <span>@${esc(p.author_username)}</span>
                        <span class="post__dot">·</span>
                        <time title="${esc(fmtFullDate(p.created_at))}">${esc(fmtRelative(p.created_at))}</time>
                        ${isOwn ? `<span class="post__vis" title="Visibility: ${esc(p.visibility)}">${visIcon}</span>` : ''}
                        ${p.is_edited ? `<span class="post__edited">· edited</span>` : ''}
                    </div>
                </div>
                ${isOwn ? `
                    <div class="post__actions">
                        <button type="button" class="post__action-btn" data-action="edit" title="Edit">✎</button>
                        <button type="button" class="post__action-btn post__action-btn--danger" data-action="delete" title="Delete">×</button>
                    </div>
                ` : ''}
            </header>

            <div class="post__body" data-body>
                ${p.content ? `<p class="post__content">${esc(p.content)}</p>` : ''}
                ${renderAttachments(p.attachments)}
            </div>

            <footer class="post__foot">
                <a href="/posts/view.php?id=${p.id}" class="post__link">Permalink</a>
            </footer>
        `;

        if (isOwn) {
            const editBtn = card.querySelector('[data-action="edit"]');
            const delBtn  = card.querySelector('[data-action="delete"]');
            if (editBtn) editBtn.addEventListener('click', () => enterEditMode(card, p));
            if (delBtn)  delBtn.addEventListener('click', () => deletePost(card, p));
        }

        return card;
    }

    /* ══════════════════════════════════════════════════════════════════
     * INLINE EDIT
     * ================================================================ */

    function enterEditMode(card, post) {
        const bodyEl   = card.querySelector('[data-body]');
        const original = post.content;

        const attachmentsHtml = renderAttachments(post.attachments);

        bodyEl.innerHTML = `
            <textarea class="post__edit-text" maxlength="2000" rows="4">${esc(original)}</textarea>
            ${attachmentsHtml}
            <div class="post__edit-bar">
                <div class="post__edit-vis" role="radiogroup" aria-label="Visibility">
                    <button type="button" class="vis-btn ${post.visibility === 'public'      ? 'is-active' : ''}" data-vis="public">🌐 Public</button>
                    <button type="button" class="vis-btn ${post.visibility === 'connections' ? 'is-active' : ''}" data-vis="connections">⚔ Connections</button>
                    <button type="button" class="vis-btn ${post.visibility === 'private'     ? 'is-active' : ''}" data-vis="private">🔒 Private</button>
                </div>
                <div class="post__edit-actions">
                    <button type="button" class="btn-cyber btn-cyber--sm" data-action="cancel">Cancel</button>
                    <button type="button" class="btn-cyber btn-cyber--sm btn-gold" data-action="save">Save</button>
                </div>
            </div>
        `;

        const textarea = bodyEl.querySelector('.post__edit-text');
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);

        let editVis = post.visibility;
        bodyEl.querySelectorAll('.post__edit-vis .vis-btn').forEach(b => {
            b.addEventListener('click', () => {
                bodyEl.querySelectorAll('.post__edit-vis .vis-btn').forEach(x => x.classList.remove('is-active'));
                b.classList.add('is-active');
                editVis = b.dataset.vis;
            });
        });

        bodyEl.querySelector('[data-action="cancel"]').addEventListener('click', () => {
            bodyEl.innerHTML = `
                ${original ? `<p class="post__content">${esc(original)}</p>` : ''}
                ${attachmentsHtml}
            `;
        });

        bodyEl.querySelector('[data-action="save"]').addEventListener('click', async () => {
            const newContent = textarea.value.trim();
            if (!newContent && (!post.attachments || post.attachments.length === 0)) {
                toast('Post cannot be empty.', 'error'); return;
            }

            try {
                const result = await api('POST', '/posts/update.php', {
                    id: post.id,
                    content: newContent,
                    visibility: editVis,
                });
                const fresh = result.post;
                post.content    = fresh.content;
                post.visibility = fresh.visibility;
                post.is_edited  = fresh.is_edited;
                card.replaceWith(renderPost(post));
                toast('Post updated ✓', 'success');
            } catch (e) {
                if (e.code === 'unauthenticated') return;
                err('update failed', e);
                toast(e.message || 'Could not update post.', 'error');
            }
        });
    }

    /* ══════════════════════════════════════════════════════════════════
     * DELETE
     * ================================================================ */

    async function deletePost(card, post) {
        if (!confirm('Delete this post? This cannot be undone.')) return;

        try {
            await api('POST', '/posts/delete.php', { id: post.id });
            card.style.transition = 'opacity 240ms, transform 240ms';
            card.style.opacity    = '0';
            card.style.transform  = 'scale(0.96)';
            setTimeout(() => card.remove(), 260);
            toast('Post deleted. −10 reputation.', 'success');
        } catch (e) {
            if (e.code === 'unauthenticated') return;
            err('delete failed', e);
            toast(e.message || 'Could not delete post.', 'error');
        }
    }

    /* ══════════════════════════════════════════════════════════════════
     * FEED LOADING
     * ================================================================ */

    async function loadFeed({ reset = true } = {}) {
        if (!reset && loadingMore) return;
        if (reset) {
            if (listEl) listEl.innerHTML = '';
            nextCursor = null;
            if (emptyEl) emptyEl.hidden = true;
        }
        loadingMore = true;

        try {
            const cursorQs = nextCursor ? `&cursor=${encodeURIComponent(nextCursor)}` : '';
            const data = await api('GET', `/feed.php?scope=${scope}&limit=20${cursorQs}`);

            const posts = data.posts || [];
            if (reset && posts.length === 0) {
                if (emptyEl) emptyEl.hidden = false;
                if (moreEl)  moreEl.hidden  = true;
                return;
            }

            posts.forEach(p => listEl.appendChild(renderPost(p)));

            nextCursor = data.next_cursor || null;
            if (moreEl) moreEl.hidden = !data.has_more;
            log('loaded', posts.length, 'posts');
        } catch (e) {
            if (e.code === 'unauthenticated') return;
            err('feed load failed', e);
            if (reset) showError(e.message || 'Could not load feed.');
            else toast(e.message || 'Could not load more.', 'error');
        } finally {
            loadingMore = false;
        }
    }

    /* ══════════════════════════════════════════════════════════════════
     * COMPOSER
     * ================================================================ */

    function wireComposer() {
        if (!composerText || !composerSubmit) return;

        composerText.addEventListener('input', () => {
            composerText.style.height = 'auto';
            composerText.style.height = Math.min(composerText.scrollHeight, 300) + 'px';
            updateComposerState();
        });

        document.querySelectorAll('#composer .vis-btn').forEach(b => {
            b.addEventListener('click', () => {
                document.querySelectorAll('#composer .vis-btn').forEach(x => x.classList.remove('is-active'));
                b.classList.add('is-active');
                visibility = b.dataset.vis;
            });
        });

        composerSubmit.addEventListener('click', submitPost);

        composerText.addEventListener('keydown', e => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                if (!composerSubmit.disabled) submitPost();
            }
        });

        if (attachBtn && attachInput) {
            attachBtn.addEventListener('click', () => {
                if (pendingAttachments.length >= MAX_ATTACHMENTS) {
                    toast(`Maximum ${MAX_ATTACHMENTS} attachments per post.`, 'error');
                    return;
                }
                attachInput.click();
            });
            attachInput.addEventListener('change', async (e) => {
                const files = Array.from(e.target.files || []);
                if (!files.length) return;
                const slotsLeft = MAX_ATTACHMENTS - pendingAttachments.length;
                for (const file of files.slice(0, slotsLeft)) {
                    await uploadAttachment(file);
                }
                e.target.value = '';
                updateComposerState();
            });
        }
    }

    function updateComposerState() {
        const len = composerText ? composerText.value.length : 0;
        if (composerCount) {
            composerCount.textContent = len + ' / 2000';
            composerCount.classList.toggle('is-warn', len > 1800);
        }
        const hasText = composerText && composerText.value.trim().length > 0;
        const hasAtt  = pendingAttachments.length > 0;
        if (composerSubmit) composerSubmit.disabled = !hasText && !hasAtt;
    }

    /* ══════════════════════════════════════════════════════════════════
     * ATTACHMENT UPLOAD
     * ================================================================ */

    async function uploadAttachment(file) {
        const fd = new FormData();
        fd.append('file', file);

        // Optimistic preview chip
        const chip = document.createElement('div');
        chip.className = 'attach-chip is-uploading';

        const previewUrl = file.type.startsWith('image/')
            ? URL.createObjectURL(file)
            : null;

        chip.innerHTML = previewUrl
            ? `<img src="${previewUrl}" alt=""><span class="attach-chip__spinner"></span>`
            : `<span class="attach-chip__icon">${fileIcon(file.type)}</span><span class="attach-chip__spinner"></span>`;
        if (attachList) attachList.appendChild(chip);

        try {
            const t = await mintCsrf();
            const res = await fetch(API_BASE + '/upload/media.php', {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'X-Citadel-Client': CLIENT,
                    'X-CSRF-Token': t || '',
                },
                body: fd,
            });

            let data = null;
            try { data = await res.json(); } catch (_) {}

            if (res.status === 401) {
                const next = encodeURIComponent(location.pathname + location.search);
                window.location.href = `${LOGIN_URL}?next=${next}`;
                throw new Error('unauthenticated');
            }

            if (!res.ok || !data || data.status === 'error') {
                throw new Error((data && data.message) || 'Upload failed (' + res.status + ')');
            }

            chip.remove();
            pendingAttachments.push({
                token: data.token,
                url:   data.url,
                kind:  data.kind,
                mime:  data.mime,
                name:  data.name || file.name,
                size:  data.size || file.size,
            });
            renderPendingAttachments();
            updateComposerState();
        } catch (e) {
            err('attachment upload failed', e);
            chip.remove();
            if (e.message !== 'unauthenticated') {
                toast(e.message || 'Upload failed.', 'error');
            }
        } finally {
            if (previewUrl) URL.revokeObjectURL(previewUrl);
        }
    }

    function renderPendingAttachments() {
        if (!attachList) return;
        attachList.innerHTML = '';

        pendingAttachments.forEach((att, idx) => {
            const chip = document.createElement('div');
            chip.className = 'attach-chip';

            if (att.kind === 'image') {
                chip.innerHTML = `<img src="${esc(att.url)}" alt="">`;
            } else if (att.kind === 'video') {
                chip.innerHTML = `<video src="${esc(att.url)}" muted></video>`;
            } else {
                chip.innerHTML = `<span class="attach-chip__icon">${fileIcon(att.mime)}</span>`;
            }

            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'attach-chip__remove';
            remove.textContent = '×';
            remove.title = 'Remove';
            remove.addEventListener('click', () => {
                pendingAttachments.splice(idx, 1);
                renderPendingAttachments();
                updateComposerState();
            });
            chip.appendChild(remove);
            attachList.appendChild(chip);
        });
    }

    /* ══════════════════════════════════════════════════════════════════
     * SUBMIT POST
     * ================================================================ */

    async function submitPost() {
        const content = composerText.value.trim();
        if (!content && pendingAttachments.length === 0) return;

        composerSubmit.disabled = true;
        composerSubmit.textContent = 'Posting…';

        const attachmentsToSend = pendingAttachments.slice();

        try {
            const result = await api('POST', '/posts/create.php', {
                content,
                visibility,
                attachment_tokens: attachmentsToSend.map(a => a.token),
            });

            // Optimistic insert
            const post = {
                id:                   result.post_id,
                user_id:              currentUser.id,
                content,
                visibility,
                created_at:           new Date().toISOString(),
                is_edited:            false,
                author_username:      currentUser.username,
                author_display_name:  currentUser.display_name || currentUser.username,
                author_avatar_url:    resolveAvatar(currentUser),
                attachments:          attachmentsToSend,
            };

            if (listEl) {
                if (listEl.firstChild) listEl.insertBefore(renderPost(post), listEl.firstChild);
                else listEl.appendChild(renderPost(post));
            }
            if (emptyEl) emptyEl.hidden = true;

            // Reset composer
            composerText.value = '';
            composerText.style.height = 'auto';
            pendingAttachments = [];
            renderPendingAttachments();
            updateComposerState();

            toast('Posted. +10 reputation ✓', 'success');
        } catch (e) {
            if (e.code === 'unauthenticated') return;
            err('post failed', e);
            toast(e.message || 'Could not create post.', 'error');
        } finally {
            composerSubmit.textContent = 'Post';
            updateComposerState();
        }
    }

    /* ══════════════════════════════════════════════════════════════════
     * SCOPES
     * ================================================================ */

    function wireScopes() {
        document.querySelectorAll('.feed-scope').forEach(b => {
            b.addEventListener('click', () => {
                document.querySelectorAll('.feed-scope').forEach(x => x.classList.remove('is-active'));
                b.classList.add('is-active');
                scope = b.dataset.scope;
                loadFeed({ reset: true });
            });
        });

        if (moreBtn) moreBtn.addEventListener('click', () => loadFeed({ reset: false }));
    }

    /* ══════════════════════════════════════════════════════════════════
     * STATUS
     * ================================================================ */

    function showError(msg) {
        if (loadingEl) loadingEl.hidden = true;
        if (shellEl)   shellEl.hidden   = true;
        if (errorEl)   errorEl.hidden   = false;
        if (errorMsgEl) errorMsgEl.textContent = msg;
    }

    function showLoading() {
        if (loadingEl) loadingEl.hidden = false;
        if (errorEl)   errorEl.hidden   = true;
        if (shellEl)   shellEl.hidden   = true;
    }

    function showShell() {
        if (loadingEl) loadingEl.hidden = true;
        if (errorEl)   errorEl.hidden   = true;
        if (shellEl)   shellEl.hidden   = false;
    }

    /* ══════════════════════════════════════════════════════════════════
     * BOOT
     * ================================================================ */

    async function boot() {
        log('boot starting');
        showLoading();

        let user = null;
        try {
            user = await resolveCurrentUser();
        } catch (e) {
            if (e.code === 'unauthenticated') return;
            err('resolveCurrentUser threw:', e);
        }

        if (!user) {
            log('no authenticated user — redirecting');
            const next = encodeURIComponent(location.pathname + location.search);
            window.location.href = `${LOGIN_URL}?next=${next}`;
            return;
        }

        currentUser = user;
        log('authenticated as', currentUser.username);

        renderIdentity(currentUser);
        if (!wired) {
            wireComposer();
            wireScopes();
            wired = true;
        }

        showShell();
        loadFeed({ reset: true });
    }

    if (retryBtn) retryBtn.addEventListener('click', boot);

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

    log('boot scheduled');

})();