/* ============================================================================
 * ███ FEED.JS ███
 * MyCitadel — Aggregated timeline (tier-aware, with reactions & comments)
 * ========================================================================== */

(function () {
    'use strict';

    const root = document.querySelector('.feed-root');
    if (!root) return;

    const API_BASE  = root.dataset.apiBase  || 'https://api.mycitadel.lol/v1';
    const CLIENT    = root.dataset.client   || 'browser/1.0.0';
    const LOGIN_URL = root.dataset.loginUrl || '/login';

    const DEFAULT_AVATAR = 'https://mycitadel.lol/img/users/default/avatar.png';

    /* ── Tier limits ────────────────────────────────────────────────── */
    const TIER_LIMITS = {
        free: {
            tier:                      'free',
            post_max_chars:            50,
            post_max_attachments:      1,
            post_allowed_kinds:        ['image'],
            comment_max_chars:         25,
            comment_max_attachments:   1,
            comment_allowed_kinds:     ['image'],
            reactions_allowed:         ['like', 'dislike'],
        },
        premium: {
            tier:                      'premium',
            post_max_chars:            1500,
            post_max_attachments:      10,
            post_allowed_kinds:        ['image', 'video', 'audio', 'document'],
            comment_max_chars:         1500,
            comment_max_attachments:   5,
            comment_allowed_kinds:     ['image', 'video', 'audio', 'document'],
            reactions_allowed:         ['like', 'dislike', 'heart', 'angry'],
        },
    };

    const KIND_MIME = {
        image:    'image/jpeg,image/png,image/webp,image/gif',
        video:    'video/mp4,video/webm',
        audio:    'audio/mpeg,audio/ogg,audio/wav',
        document: 'application/pdf,text/plain,text/markdown,application/zip',
    };

    const REACTION_ICONS = {
        like:    '👍',
        dislike: '👎',
        heart:   '❤',
        angry:   '😡',
    };
    const REACTION_LABELS = {
        like:    'Like',
        dislike: 'Dislike',
        heart:   'Heart',
        angry:   'Angry',
    };

    /* ── DOM refs ───────────────────────────────────────────────────── */
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

    /* ── Runtime state ──────────────────────────────────────────────── */
    let currentUser        = null;
    let limits             = TIER_LIMITS.free;
    let scope              = 'all';
    let nextCursor         = null;
    let loadingMore        = false;
    let visibility         = 'public';
    let wired              = false;
    let delegatesWired     = false;
    let csrfToken          = null;
    let csrfPromise        = null;
    let pendingAttachments = [];

    const log  = (...a) => console.log('[feed]', ...a);
    const warn = (...a) => console.warn('[feed]', ...a);
    const err  = (...a) => console.error('[feed]', ...a);

    /* ══════════════════════════════════════════════════════════════════
     * TIER RESOLUTION
     * ================================================================ */

    function resolveLimits(user) {
        const base = (user && (user.premium === true || user.is_premium === true))
            ? TIER_LIMITS.premium
            : TIER_LIMITS.free;

        if (user && user.limits && typeof user.limits === 'object') {
            return Object.assign({}, base, user.limits);
        }
        return base;
    }

    function buildMimeAccept(kinds) {
        return (kinds || ['image']).map(k => KIND_MIME[k] || '').filter(Boolean).join(',');
    }

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

    function resolveAvatar(source) {
        if (!source) return DEFAULT_AVATAR;
        const candidates = [
            source.author_avatar_url, source.avatar_url,
            source.user_avatar_url, source.avatarUrl,
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
     * CSRF / API
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
        const c = citadelCsrf();
        if (c) { csrfToken = c; return csrfToken; }

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
     * USER RESOLUTION
     * ================================================================ */

    async function resolveCurrentUser() {
        try {
            if (window.Citadel && window.Citadel.user) return window.Citadel.user;
        } catch (_) {}

        const ev = await waitForCitadelEvent(2500);
        if (ev) return ev;

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

        const tierPill = limits.tier === 'premium'
            ? `<span class="feed-identity__tier feed-identity__tier--premium">★ PREMIUM</span>`
            : `<span class="feed-identity__tier feed-identity__tier--free">FREE</span>`;

        const identityEl = document.getElementById('feed-identity-card');
        if (identityEl) {
            identityEl.innerHTML = `
                <div class="feed-identity">
                    <div class="feed-identity__avatar">${avatarHtml}</div>
                    <div class="feed-identity__meta">
                        <p class="feed-identity__name">${esc(user.display_name || user.username)}</p>
                        <p class="feed-identity__handle">@${esc(user.username)}</p>
                    </div>
                    ${tierPill}
                </div>
                <a href="/users/dashboard.php" class="feed-identity__link">View Dashboard →</a>
            `;
        }

        if (composerAvatar) composerAvatar.innerHTML = `<img src="${esc(avatarUrl)}" alt="">`;
    }

    function ensureUpsellStrip() {
        const composer = document.getElementById('composer');
        if (!composer) return;

        let strip = document.getElementById('composer-upsell');
        if (strip) { strip.hidden = limits.tier === 'premium'; return; }
        if (limits.tier !== 'free') return;

        strip = document.createElement('div');
        strip.className = 'composer__upsell';
        strip.id = 'composer-upsell';
        strip.innerHTML = `
            <span class="composer__upsell-icon" aria-hidden="true">★</span>
            <span class="composer__upsell-text">
                Free tier: <strong>${limits.post_max_chars}</strong> characters,
                <strong>${limits.post_max_attachments}</strong> image.
            </span>
            <a href="/premium" class="composer__upsell-link">Go Premium</a>
            <span class="composer__upsell-text">
                for <strong>1,500</strong> characters and <strong>10</strong> attachments.
            </span>
        `;
        composer.appendChild(strip);
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
     * REACTIONS
     * ================================================================ */

    function renderReactionBar(post) {
        const allowed = (limits.reactions_allowed || ['like', 'dislike']);
        const viewer  = post.viewer_reaction || null;
        const total   = post.reaction_count || 0;

        const buttons = allowed.map(r => {
            const active = viewer === r ? ' is-active' : '';
            return `
                <button type="button"
                        class="reaction-btn reaction-btn--${r}${active}"
                        data-reaction="${r}"
                        title="${REACTION_LABELS[r]}">
                    <span class="reaction-btn__icon">${REACTION_ICONS[r]}</span>
                    <span class="reaction-btn__label">${REACTION_LABELS[r]}</span>
                </button>
            `;
        }).join('');

        const totalHtml = total > 0
            ? `<span class="post__reaction-total" data-reaction-total>${total} reaction${total === 1 ? '' : 's'}</span>`
            : `<span class="post__reaction-total" data-reaction-total></span>`;

        return `
            <div class="post__reactions" data-reactions>
                ${buttons}
                ${totalHtml}
            </div>
        `;
    }

    async function toggleReaction(post, reaction, btn) {
        const container = btn.closest('[data-reactions]');
        if (!container) return;

        const allBtns  = container.querySelectorAll('.reaction-btn');
        const totalEl  = container.querySelector('[data-reaction-total]');
        const wasActive = btn.classList.contains('is-active');
        const priorViewer = post.viewer_reaction || null;

        // Optimistic: compute new local state
        const newViewer = wasActive ? null : reaction;
        let delta = 0;
        if (wasActive)         delta = -1;
        else if (!priorViewer) delta = 1;

        const optimisticCount = Math.max(0, (post.reaction_count || 0) + delta);
        applyReactionUI(container, allBtns, totalEl, newViewer, optimisticCount);

        try {
            const result = await api('POST', '/reactions/toggle.php', {
                target_type: 'post',
                target_id:   post.id,
                reaction:    reaction,
            });

            post.viewer_reaction = result.reaction;
            post.reaction_count  = result.count;
            applyReactionUI(container, allBtns, totalEl, result.reaction, result.count);
        } catch (e) {
            if (e.code === 'unauthenticated') return;
            // Revert
            post.viewer_reaction = priorViewer;
            post.reaction_count  = Math.max(0, optimisticCount - delta);
            applyReactionUI(container, allBtns, totalEl, priorViewer, post.reaction_count);
            toast(e.message || 'Could not save reaction.', 'error');
        }
    }

    function applyReactionUI(container, allBtns, totalEl, viewerReaction, count) {
        allBtns.forEach(b => b.classList.remove('is-active'));
        if (viewerReaction) {
            const active = container.querySelector(`.reaction-btn[data-reaction="${viewerReaction}"]`);
            if (active) active.classList.add('is-active');
        }
        if (totalEl) {
            totalEl.textContent = count > 0
                ? `${count} reaction${count === 1 ? '' : 's'}`
                : '';
        }
    }

    /* ══════════════════════════════════════════════════════════════════
     * COMMENTS
     * ================================================================ */

    function renderComment(c) {
        const avatarUrl = resolveAvatar(c);
        const initials  = initialsOf(c.author_display_name || c.author_username);
        const avatarHtml = `<img src="${esc(avatarUrl)}" alt=""
                                 onerror="this.replaceWith(document.createTextNode('${esc(initials)}'))">`;

        const isMine = currentUser && c.user_id === currentUser.id;

        const el = document.createElement('div');
        el.className = 'comment' + (isMine ? ' comment--mine' : '');
        el.dataset.commentId = c.id;

        el.innerHTML = `
            <div class="comment__avatar">
                <a href="/users/view.php?id=${c.user_id}">${avatarHtml}</a>
            </div>
            <div class="comment__body">
                <div class="comment__head">
                    <a href="/users/view.php?id=${c.user_id}" class="comment__name">
                        ${esc(c.author_display_name || c.author_username)}
                    </a>
                    <span class="comment__handle">@${esc(c.author_username)}</span>
                    <span class="comment__dot">·</span>
                    <time class="comment__time" title="${esc(fmtFullDate(c.created_at))}">${esc(fmtRelative(c.created_at))}</time>
                </div>
                <div class="comment__content">${esc(c.content)}</div>
            </div>
        `;
        return el;
    }

    async function loadComments(post, commentsEl, listEl) {
        if (listEl.dataset.loaded === '1') return;

        listEl.innerHTML = `<div class="comment-loading">Loading comments…</div>`;

        try {
            const data = await api('GET', `/comments/list.php?post_id=${post.id}&limit=50`);
            const comments = data.comments || [];

            if (comments.length === 0) {
                listEl.innerHTML = `<div class="comment-empty">No comments yet. Be the first.</div>`;
            } else {
                listEl.innerHTML = '';
                comments.forEach(c => listEl.appendChild(renderComment(c)));
            }
            listEl.dataset.loaded = '1';
        } catch (e) {
            if (e.code === 'unauthenticated') return;
            listEl.innerHTML = `<div class="comment-empty">${esc(e.message || 'Could not load comments.')}</div>`;
        }
    }

    async function submitComment(post, form) {
        const textarea = form.querySelector('textarea');
        const content  = textarea.value.trim();
        if (!content) return;

        if (content.length > limits.comment_max_chars) {
            toast(`Comments are limited to ${limits.comment_max_chars} characters on your tier.`, 'error');
            return;
        }

        const submitBtn = form.querySelector('button[type="submit"]');
        const original  = submitBtn.textContent;
        submitBtn.disabled = true;
        submitBtn.textContent = 'Posting…';

        try {
            const result = await api('POST', '/comments/create.php', {
                post_id:   post.id,
                content,
                parent_id: null,
            });

            const newComment = {
                id: result.comment_id,
                post_id: post.id,
                user_id: currentUser.id,
                content,
                created_at: new Date().toISOString(),
                author_username:     currentUser.username,
                author_display_name: currentUser.display_name || currentUser.username,
                author_avatar_url:   resolveAvatar(currentUser),
            };

            const listEl = form.closest('[data-comments]').querySelector('[data-comments-list]');
            if (listEl) {
                const emptyMsg = listEl.querySelector('.comment-empty');
                if (emptyMsg) emptyMsg.remove();
                listEl.appendChild(renderComment(newComment));
            }

            // Update comment count on the toggle
            const postEl = form.closest('.post');
            const countEl = postEl ? postEl.querySelector('[data-comment-count]') : null;
            post.comment_count = (post.comment_count || 0) + 1;
            if (countEl) countEl.textContent = `Comments (${post.comment_count})`;

            textarea.value = '';
            updateCommentCounter(form);
            toast('Comment posted. +5 reputation ✓', 'success');
        } catch (e) {
            if (e.code === 'unauthenticated') return;
            toast(e.message || 'Could not post comment.', 'error');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = original;
        }
    }

    function updateCommentCounter(form) {
        const textarea = form.querySelector('textarea');
        const counter  = form.querySelector('[data-comment-count-label]');
        if (!textarea || !counter) return;
        const len = textarea.value.length;
        counter.textContent = `${len} / ${limits.comment_max_chars}`;
        counter.classList.toggle('is-warn', len > Math.floor(limits.comment_max_chars * 0.9));
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
        card._post = p;   // stash the raw object for delegated handlers

        const avatarUrl  = resolveAvatar(p);
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

            ${renderReactionBar(p)}

            <footer class="post__foot">
                <button type="button" class="post__comments-toggle" data-action="comments">
                    💬 <span data-comment-count>Comments (${p.comment_count || 0})</span>
                </button>
                <a href="/posts/view.php?id=${p.id}" class="post__link">Permalink</a>
            </footer>

            <div class="post__comments" data-comments hidden>
                <div class="post__comments-list" data-comments-list></div>
                <form class="post__comment-form" data-comment-form autocomplete="off">
                    <textarea
                        rows="2"
                        maxlength="${limits.comment_max_chars}"
                        placeholder="Write a comment…"
                        data-comment-input></textarea>
                    <div class="post__comment-form-bar">
                        <span class="post__comment-counter" data-comment-count-label>0 / ${limits.comment_max_chars}</span>
                        <button type="submit" class="btn-cyber btn-cyber--sm btn-gold">Comment</button>
                    </div>
                </form>
            </div>
        `;

        if (isOwn) {
            const editBtn = card.querySelector('[data-action="edit"]');
            const delBtn  = card.querySelector('[data-action="delete"]');
            if (editBtn) editBtn.addEventListener('click', () => enterEditMode(card, p));
            if (delBtn)  delBtn.addEventListener('click', () => deletePost(card, p));
        }

        // Wire comment textarea counter (local — no delegation needed)
        const cForm = card.querySelector('[data-comment-form]');
        if (cForm) {
            const ta = cForm.querySelector('textarea');
            ta.addEventListener('input', () => updateCommentCounter(cForm));
        }

        return card;
    }

    /* ══════════════════════════════════════════════════════════════════
     * DELEGATED EVENTS (reactions, comments — dynamically added posts)
     * ================================================================ */

    function wireFeedDelegates() {
        if (delegatesWired || !listEl) return;
        delegatesWired = true;

        listEl.addEventListener('click', async (ev) => {
            const reactBtn = ev.target.closest('.reaction-btn');
            if (reactBtn) {
                ev.preventDefault();
                const postEl = reactBtn.closest('.post');
                if (!postEl || !postEl._post) return;
                await toggleReaction(postEl._post, reactBtn.dataset.reaction, reactBtn);
                return;
            }

            const toggle = ev.target.closest('[data-action="comments"]');
            if (toggle) {
                ev.preventDefault();
                const postEl = toggle.closest('.post');
                if (!postEl || !postEl._post) return;
                const commentsEl = postEl.querySelector('[data-comments]');
                const listInnerEl = postEl.querySelector('[data-comments-list]');
                if (!commentsEl || !listInnerEl) return;
                commentsEl.hidden = !commentsEl.hidden;
                if (!commentsEl.hidden) {
                    await loadComments(postEl._post, commentsEl, listInnerEl);
                }
            }
        });

        listEl.addEventListener('submit', async (ev) => {
            const form = ev.target.closest('[data-comment-form]');
            if (!form) return;
            ev.preventDefault();
            const postEl = form.closest('.post');
            if (!postEl || !postEl._post) return;
            await submitComment(postEl._post, form);
        });
    }

    /* ══════════════════════════════════════════════════════════════════
     * INLINE EDIT
     * ================================================================ */

    function enterEditMode(card, post) {
        const bodyEl   = card.querySelector('[data-body]');
        const original = post.content;
        const editMaxLen = Math.max(limits.post_max_chars, (original || '').length);
        const attachmentsHtml = renderAttachments(post.attachments);

        bodyEl.innerHTML = `
            <textarea class="post__edit-text" maxlength="${editMaxLen}" rows="4">${esc(original)}</textarea>
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

        composerText.maxLength = limits.post_max_chars;
        if (attachInput) {
            attachInput.accept   = buildMimeAccept(limits.post_allowed_kinds);
            attachInput.multiple = limits.post_max_attachments > 1;
        }

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
                if (pendingAttachments.length >= limits.post_max_attachments) {
                    const plural = limits.post_max_attachments === 1 ? 'attachment' : 'attachments';
                    const extra  = limits.tier === 'free'
                        ? ' Upgrade to Premium for up to 10.' : '';
                    toast(`Maximum ${limits.post_max_attachments} ${plural} per post.${extra}`, 'error');
                    return;
                }
                attachInput.click();
            });

            attachInput.addEventListener('change', async (e) => {
                const files = Array.from(e.target.files || []);
                if (!files.length) return;
                const slotsLeft = limits.post_max_attachments - pendingAttachments.length;
                for (const file of files.slice(0, slotsLeft)) {
                    await uploadAttachment(file);
                }
                if (files.length > slotsLeft) {
                    toast(`Only ${slotsLeft} slot(s) remaining at your tier.`, 'error');
                }
                e.target.value = '';
                updateComposerState();
            });
        }
    }

    function updateComposerState() {
        const len = composerText ? composerText.value.length : 0;
        const max = limits.post_max_chars;

        if (composerCount) {
            composerCount.textContent = len + ' / ' + max;
            composerCount.classList.toggle('is-warn', len > Math.floor(max * 0.9));
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

        if (content.length > limits.post_max_chars) {
            toast(`Posts are limited to ${limits.post_max_chars} characters on your tier.`, 'error');
            return;
        }
        if (pendingAttachments.length > limits.post_max_attachments) {
            toast(`Posts are limited to ${limits.post_max_attachments} attachment(s) on your tier.`, 'error');
            return;
        }

        composerSubmit.disabled = true;
        composerSubmit.textContent = 'Posting…';

        const attachmentsToSend = pendingAttachments.slice();

        try {
            const result = await api('POST', '/posts/create.php', {
                content,
                visibility,
                attachment_tokens: attachmentsToSend.map(a => a.token),
            });

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
                reaction_count:       0,
                viewer_reaction:      null,
                comment_count:        0,
            };

            if (listEl) {
                if (listEl.firstChild) listEl.insertBefore(renderPost(post), listEl.firstChild);
                else listEl.appendChild(renderPost(post));
            }
            if (emptyEl) emptyEl.hidden = true;

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
        try { user = await resolveCurrentUser(); }
        catch (e) {
            if (e.code === 'unauthenticated') return;
            err('resolveCurrentUser threw:', e);
        }

        if (!user) {
            const next = encodeURIComponent(location.pathname + location.search);
            window.location.href = `${LOGIN_URL}?next=${next}`;
            return;
        }

        currentUser = user;
        limits      = resolveLimits(user);
        log('authenticated as', currentUser.username, '| tier:', limits.tier);

        renderIdentity(currentUser);
        ensureUpsellStrip();

        if (!wired) {
            wireComposer();
            wireScopes();
            wireFeedDelegates();
            wired = true;
        }

        updateComposerState();
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