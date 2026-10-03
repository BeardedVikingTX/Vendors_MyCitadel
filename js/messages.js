/* ============================================================================
 * ███ MESSAGES.JS ███
 * MyCitadel — Encrypted chat client with long-poll delivery.
 * ----------------------------------------------------------------------------
 * Flow:
 *   1. Load conversations list
 *   2. If ?c=N present, open that thread
 *   3. Start a long-poll stream against /v1/messages/stream.php?since=LAST_ID
 *   4. Incoming messages render in-place; inbox updates previews
 *   5. Sending optimistically inserts and reconciles with the server ID
 *
 * TIER AWARENESS
 *   Free    — 1 attachment per message, images only. No conversation deletion.
 *   Premium — 10 attachments, all file types. Can destroy conversations they
 *             participate in (hard delete, all participants).
 *
 * Encryption: server-side (ChaCha20-Poly1305). Ciphertext travels as-is
 * over HTTPS; plaintext exists only in the browser memory after decryption.
 * ========================================================================== */

(function () {
    'use strict';

    const root = document.querySelector('.msg-root');
    if (!root) return;

    const API_BASE  = root.dataset.apiBase  || 'https://api.mycitadel.lol/v1';
    const CLIENT    = root.dataset.client   || 'browser/1.0.0';
    const LOGIN_URL = root.dataset.loginUrl || '/login';
    const INITIAL_C = parseInt(root.dataset.initialConversation, 10) || 0;

    /* ── Tier limits — mirror messages/send.php ─────────────────────── */
    const TIER_LIMITS = {
        free: {
            tier:                   'free',
            message_max_attachments: 1,
            message_allowed_kinds:  ['image'],
            can_delete_conversations: false,
        },
        premium: {
            tier:                   'premium',
            message_max_attachments: 10,
            message_allowed_kinds:  ['image', 'video', 'audio', 'document'],
            can_delete_conversations: true,
        },
    };

    /* MIME strings for the file picker's accept="" attribute */
    const KIND_MIME = {
        image:    'image/jpeg,image/png,image/webp,image/gif',
        video:    'video/mp4,video/webm',
        audio:    'audio/mpeg,audio/ogg,audio/wav',
        document: 'application/pdf,text/plain,text/markdown,application/zip',
    };

    const loadingEl   = document.getElementById('msg-loading');
    const errorEl     = document.getElementById('msg-error');
    const errorTextEl = document.getElementById('msg-error-text');
    const retryBtn    = document.getElementById('msg-retry');
    const shellEl     = document.getElementById('msg-shell');
    const convListEl  = document.getElementById('msg-conv-list');
    const convEmptyEl = document.getElementById('msg-conv-empty');
    const blankEl     = document.getElementById('msg-blank');
    const threadEl    = document.getElementById('msg-thread');
    const threadHead  = document.getElementById('msg-thread-head');
    const threadBody  = document.getElementById('msg-thread-body');
    const composer    = document.getElementById('msg-composer');
    const inputEl     = document.getElementById('msg-input');
    const sendBtn     = document.getElementById('msg-send-btn');
    const attachBtn   = document.getElementById('msg-attach-btn');
    const fileInput   = document.getElementById('msg-file-input');
    const attachRow   = document.getElementById('msg-attach-row');
    const toastLayer  = document.getElementById('msg-toast-layer');

    const DEFAULT_AVATAR = 'https://mycitadel.lol/img/users/default/avatar.png';

    let csrfToken     = null;
    let csrfPromise   = null;
    let currentUser   = null;
    let limits        = TIER_LIMITS.free;   // conservative until /me resolves
    let conversations = [];
    let activeConvId  = null;
    let activeOther   = null;
    let messages      = [];
    let lastStreamId  = 0;
    let pendingAtts   = [];
    let streaming     = false;
    let streamAbort   = null;

    const log  = (...a) => console.log('[msg]', ...a);
    const warn = (...a) => console.warn('[msg]', ...a);
    const err  = (...a) => console.error('[msg]', ...a);

    /* ══════════════════════════════════════════════════════════════
     * TIER RESOLUTION
     * ================================================================ */

    function resolveLimits(user) {
        const base = (user && (user.premium === true || user.is_premium === true))
            ? TIER_LIMITS.premium
            : TIER_LIMITS.free;

        if (user && user.limits && typeof user.limits === 'object') {
            return Object.assign({}, base, {
                message_max_attachments:  user.limits.message_max_attachments  || base.message_max_attachments,
                message_allowed_kinds:    user.limits.message_allowed_kinds    || base.message_allowed_kinds,
                can_delete_conversations: user.limits.can_delete_conversations ?? base.can_delete_conversations,
            });
        }
        return base;
    }

    function buildMimeAccept(kinds) {
        return (kinds || ['image']).map(k => KIND_MIME[k] || '').filter(Boolean).join(',');
    }

    /* ══════════════════════════════════════════════════════════════
     * UTILITIES
     * ================================================================ */

    function esc(s) {
        if (s == null) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function escUrl(u) {
        if (!u || typeof u !== 'string') return '';
        if (!/^https?:\/\//i.test(u)) return '';
        if (/['"()\s]/.test(u)) return '';
        return u;
    }
    function initialsOf(name) {
        if (!name) return '?';
        const p = String(name).trim().split(/\s+/);
        return p.length === 1 ? p[0].slice(0, 2).toUpperCase()
            : (p[0][0] + p[p.length - 1][0]).toUpperCase();
    }
    function fmtRelative(iso) {
        if (!iso) return '—';
        const diff = (Date.now() - new Date(iso).getTime()) / 1000;
        if (diff < 60) return 'now';
        if (diff < 3600) return Math.floor(diff / 60) + 'm';
        if (diff < 86400) return Math.floor(diff / 3600) + 'h';
        if (diff < 604800) return Math.floor(diff / 86400) + 'd';
        return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
    function fmtTime(iso) {
        return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    }
    function uuidHex() {
        const a = new Uint8Array(16);
        crypto.getRandomValues(a);
        return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
    }
    function toast(msg, kind = 'info', ms = 2400) {
        if (!toastLayer) return;
        const el = document.createElement('div');
        el.className = 'msg-toast msg-toast--' + kind;
        el.textContent = msg;
        toastLayer.appendChild(el);
        requestAnimationFrame(() => el.classList.add('is-visible'));
        setTimeout(() => {
            el.classList.remove('is-visible');
            setTimeout(() => el.remove(), 200);
        }, ms);
    }

    /* ══════════════════════════════════════════════════════════════
     * CSRF + API
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
        if (c) { csrfToken = c; return c; }
        csrfPromise = (async () => {
            try {
                const res = await fetch(API_BASE + '/auth/csrf.php', {
                    credentials: 'include',
                    headers: { 'X-Citadel-Client': CLIENT },
                });
                if (!res.ok) return null;
                const d = await res.json();
                if (d && d.status === 'ok' && d.token) {
                    csrfToken = d.token;
                    return csrfToken;
                }
            } catch (_) {}
            csrfPromise = null;
            return null;
        })();
        return csrfPromise;
    }

    async function api(method, path, body, opts = {}) {
        const headers = { 'X-Citadel-Client': CLIENT };
        const hasBody = body !== undefined && body !== null;
        if (hasBody) headers['Content-Type'] = 'application/json';
        if (method !== 'GET') {
            const t = await mintCsrf();
            if (!t) throw new Error('Could not establish a secure session.');
            headers['X-CSRF-Token'] = t;
        }
        const ctrl = opts.signal ? { signal: opts.signal } : {};
        let res;
        try {
            res = await fetch(API_BASE + path, {
                method, credentials: 'include', headers,
                body: hasBody ? JSON.stringify(body) : undefined,
                ...ctrl,
            });
        } catch (e) {
            if (e.name === 'AbortError') throw e;
            throw new Error('Network error');
        }
        let data = null;
        try { data = await res.json(); } catch (_) {}
        if (data && typeof data.csrf_token === 'string' && data.csrf_token) {
            csrfToken = data.csrf_token;
        }
        if (res.status === 401) {
            const next = encodeURIComponent(location.pathname + location.search);
            window.location.href = `${LOGIN_URL}?next=${next}`;
            throw new Error('unauthenticated');
        }
        if (!res.ok) {
            const e = new Error((data && data.message) || ('Request failed (' + res.status + ')'));
            e.code = (data && data.code) || ('http_' + res.status);
            throw e;
        }
        if (!data || data.status === 'error') {
            const e = new Error((data && data.message) || 'Unexpected response.');
            e.code = (data && data.code) || 'unknown';
            throw e;
        }
        return data;
    }

    /* ══════════════════════════════════════════════════════════════
     * RESOLVE CURRENT USER
     * ================================================================ */

    async function resolveCurrentUser() {
        try {
            if (window.Citadel && window.Citadel.user) return window.Citadel.user;
        } catch (_) {}
        const u = await new Promise(resolve => {
            if (!window.addEventListener) return resolve(null);
            if (window.Citadel && window.Citadel.user) return resolve(window.Citadel.user);
            let settled = false;
            const onReady = e => {
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
            }, 2500);
        });
        if (u) return u;
        try {
            const d = await api('GET', '/users/me.php');
            return d.user || null;
        } catch (e) {
            if (e.message === 'unauthenticated') throw e;
            return null;
        }
    }

    /* ══════════════════════════════════════════════════════════════
     * CONVERSATION LIST
     * ================================================================ */

    async function loadConversations() {
        const data = await api('GET', '/messages/conversations.php');
        conversations = data.conversations || [];
        renderConversations();
    }

    function renderConversations() {
        convListEl.innerHTML = '';
        if (conversations.length === 0) {
            convEmptyEl.hidden = false;
            return;
        }
        convEmptyEl.hidden = true;

        conversations.forEach(c => {
            const el = document.createElement('button');
            el.type = 'button';
            el.className = 'msg-conv';
            if (c.id === activeConvId) el.classList.add('is-active');
            el.dataset.convId = c.id;

            const other = c.other || {};
            const name = other.display_name || other.username || 'Unknown';
            const avatarUrl = escUrl(other.avatar_url) || DEFAULT_AVATAR;
            const unread = c.unread_count > 0 ? `<span class="msg-conv__badge">${c.unread_count}</span>` : '';
            const preview = c.last_preview
                ? esc(c.last_preview)
                : '<em>No messages yet</em>';

            el.innerHTML = `
                <div class="msg-conv__avatar">
                    <img src="${avatarUrl}" alt=""
                         onerror="this.parentNode.innerHTML='<span>${esc(initialsOf(name))}</span>'">
                </div>
                <div class="msg-conv__body">
                    <div class="msg-conv__row">
                        <span class="msg-conv__name">${esc(name)}</span>
                        <span class="msg-conv__time">${esc(fmtRelative(c.last_message_at))}</span>
                    </div>
                    <div class="msg-conv__row">
                        <span class="msg-conv__preview">${preview}</span>
                        ${unread}
                    </div>
                </div>
            `;
            el.addEventListener('click', () => openConversation(c.id));
            convListEl.appendChild(el);
        });
    }

    /* ══════════════════════════════════════════════════════════════
     * THREAD
     * ================================================================ */

    async function openConversation(convId) {
        activeConvId = convId;
        blankEl.hidden = true;
        threadEl.hidden = false;

        const data = await api('GET', `/messages/thread.php?conversation_id=${convId}&limit=50`);
        messages = data.messages || [];
        activeOther = data.other || null;

        renderThreadHead();
        renderThreadBody();

        // Update URL without reload
        const url = new URL(location.href);
        url.searchParams.set('c', String(convId));
        history.replaceState(null, '', url);

        // Mark read
        const lastId = messages.length ? messages[messages.length - 1].id : 0;
        if (lastId > 0) {
            api('POST', '/messages/read.php', {
                conversation_id: convId,
                up_to_message_id: lastId,
            }).catch(() => {});
        }

        renderConversations();
    }

    function renderThreadHead() {
        if (!activeOther) return;
        const name = activeOther.display_name || activeOther.username;
        const avatarUrl = escUrl(activeOther.avatar_url) || DEFAULT_AVATAR;

        // Delete-conversation button — premium only
        const deleteBtn = limits.can_delete_conversations
            ? `<button type="button" class="msg-thread__delete" id="msg-thread-delete"
                       title="Destroy this conversation for all participants">
                   ✕
               </button>`
            : '';

        threadHead.innerHTML = `
            <a href="/users/view.php?id=${activeOther.id}" class="msg-thread__avatar-link">
                <div class="msg-thread__avatar">
                    <img src="${avatarUrl}" alt=""
                         onerror="this.parentNode.innerHTML='<span>${esc(initialsOf(name))}</span>'">
                </div>
            </a>
            <div class="msg-thread__meta">
                <a href="/users/view.php?id=${activeOther.id}" class="msg-thread__name">${esc(name)}</a>
                <span class="msg-thread__handle">@${esc(activeOther.username)}</span>
            </div>
            ${deleteBtn}
        `;

        if (limits.can_delete_conversations) {
            const del = document.getElementById('msg-thread-delete');
            if (del) del.addEventListener('click', confirmDeleteConversation);
        }
    }

    async function confirmDeleteConversation() {
        if (!activeConvId) return;
        const name = (activeOther && (activeOther.display_name || activeOther.username)) || 'this conversation';

        const confirmed = confirm(
            `Destroy your conversation with ${name} for both participants?\n\n` +
            `This is permanent. Messages, attachments, and the conversation row ` +
            `are all removed from the database. Neither of you will be able to ` +
            `recover anything from it.\n\n` +
            `Continue?`
        );
        if (!confirmed) return;

        try {
            await api('POST', '/messages/delete.php', { conversation_id: activeConvId });

            toast('Conversation destroyed.', 'success');

            // Remove from local state
            conversations = conversations.filter(c => c.id !== activeConvId);
            activeConvId = null;
            activeOther = null;
            messages = [];

            // Reset UI
            threadEl.hidden = true;
            blankEl.hidden = false;
            threadBody.innerHTML = '';
            renderConversations();

            // Update URL
            const url = new URL(location.href);
            url.searchParams.delete('c');
            history.replaceState(null, '', url);
        } catch (e) {
            if (e.message === 'unauthenticated') return;
            toast(e.message || 'Could not delete conversation.', 'error');
        }
    }

    function renderThreadBody() {
        threadBody.innerHTML = '';
        if (messages.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'msg-thread__empty';
            empty.textContent = 'No messages yet — say hi.';
            threadBody.appendChild(empty);
            return;
        }
        messages.forEach(m => threadBody.appendChild(renderMessage(m)));
        scrollToBottom();
    }

    function renderMessage(m) {
        const el = document.createElement('div');
        const isMine = currentUser && m.sender_id === currentUser.id;
        el.className = 'msg-item ' + (isMine ? 'msg-item--mine' : 'msg-item--theirs');
        el.dataset.msgId = m.id;

        let body = '';
        if (m.deleted) {
            body = '<span class="msg-item__deleted">message deleted</span>';
        } else if (m.encrypted) {
            body = '<span class="msg-item__encrypted">[unable to decrypt]</span>';
        } else {
            body = esc(m.body).replace(/\n/g, '<br>');
        }

        let atts = '';
        if (Array.isArray(m.attachments) && m.attachments.length) {
            atts = '<div class="msg-item__atts">';
            m.attachments.forEach(a => {
                const u = escUrl(a.url) || '';
                if (!u) return;
                if (a.kind === 'image') {
                    atts += `<a href="${u}" target="_blank" rel="noopener"><img src="${u}" alt="" loading="lazy"></a>`;
                } else if (a.kind === 'video') {
                    atts += `<video controls preload="metadata" src="${u}"></video>`;
                } else {
                    atts += `<a href="${u}" class="msg-item__att" target="_blank" rel="noopener">
                        <span class="msg-item__att-icon">📎</span>
                        <span class="msg-item__att-name">${esc(a.name || 'File')}</span>
                    </a>`;
                }
            });
            atts += '</div>';
        }

        el.innerHTML = `
            <div class="msg-item__bubble">
                ${body ? `<div class="msg-item__body">${body}</div>` : ''}
                ${atts}
                <div class="msg-item__meta">
                    <span class="msg-item__time">${esc(fmtTime(m.created_at))}</span>
                    ${m.edited ? '<span class="msg-item__edited">· edited</span>' : ''}
                </div>
            </div>
        `;
        return el;
    }

    function scrollToBottom() {
        requestAnimationFrame(() => {
            threadBody.scrollTop = threadBody.scrollHeight;
        });
    }

    /* ══════════════════════════════════════════════════════════════
     * LONG-POLL STREAM
     * ================================================================ */

    async function startStream() {
        if (streaming) return;
        streaming = true;

        while (streaming) {
            try {
                streamAbort = new AbortController();
                const data = await api(
                    'GET',
                    `/messages/stream.php?since=${lastStreamId}`,
                    null,
                    { signal: streamAbort.signal }
                );
                const incoming = data.messages || [];
                if (data.last_id) lastStreamId = Math.max(lastStreamId, data.last_id);

                if (incoming.length > 0) {
                    handleIncoming(incoming);
                }
                continue;
            } catch (e) {
                if (e.message === 'unauthenticated') return;
                await new Promise(r => setTimeout(r, 2000));
            }
        }
    }

    function stopStream() {
        streaming = false;
        if (streamAbort) streamAbort.abort();
    }

    function handleIncoming(incoming) {
        let affectedConvId = null;

        incoming.forEach(m => {
            if (messages.some(x => x.id === m.id)) return;

            if (m.conversation_id === activeConvId) {
                messages.push(m);
                threadBody.appendChild(renderMessage(m));
            }
            affectedConvId = m.conversation_id;

            const conv = conversations.find(c => c.id === m.conversation_id);
            if (conv) {
                conv.last_preview = m.deleted ? '[deleted]' : (m.body || '').slice(0, 100);
                conv.last_sender_id = m.sender_id;
                conv.last_message_at = m.created_at;
                if (m.conversation_id !== activeConvId && m.sender_id !== (currentUser && currentUser.id)) {
                    conv.unread_count = (conv.unread_count || 0) + 1;
                }
            }
        });

        if (affectedConvId === activeConvId) {
            scrollToBottom();
            const lastId = messages[messages.length - 1]?.id || 0;
            if (lastId > 0) {
                api('POST', '/messages/read.php', {
                    conversation_id: activeConvId,
                    up_to_message_id: lastId,
                }).catch(() => {});
            }
        }

        conversations.sort((a, b) =>
            new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0)
        );
        renderConversations();
    }

    /* ══════════════════════════════════════════════════════════════
     * COMPOSER
     * ================================================================ */

    function wireComposer() {
        inputEl.addEventListener('input', () => {
            inputEl.style.height = 'auto';
            inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + 'px';
            updateSendEnabled();
        });
        inputEl.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (!sendBtn.disabled) composer.requestSubmit();
            }
        });
        composer.addEventListener('submit', async e => {
            e.preventDefault();
            await sendMessage();
        });

        attachBtn.addEventListener('click', () => {
            const max = limits.message_max_attachments;
            if (pendingAtts.length >= max) {
                const plural = max === 1 ? 'attachment' : 'attachments';
                const hint   = limits.tier === 'free'
                    ? ' Upgrade to Premium for up to 10.'
                    : '';
                toast(`Maximum ${max} ${plural} per message.${hint}`, 'error');
                return;
            }
            fileInput.click();
        });

        fileInput.addEventListener('change', async e => {
            const files = Array.from(e.target.files || []);
            const slotsLeft = limits.message_max_attachments - pendingAtts.length;

            if (files.length > slotsLeft) {
                const plural = limits.message_max_attachments === 1 ? 'attachment' : 'attachments';
                const hint   = limits.tier === 'free'
                    ? ' Upgrade to Premium for up to 10.'
                    : '';
                toast(
                    `Only ${slotsLeft} more ${plural} allowed at your tier.${hint}`,
                    'error'
                );
            }

            for (const f of files.slice(0, slotsLeft)) {
                await uploadAttachment(f);
            }
            e.target.value = '';
            renderPendingAtts();
        });

        // Apply tier-based accept filter to the file picker
        fileInput.accept = buildMimeAccept(limits.message_allowed_kinds);
        fileInput.multiple = limits.message_max_attachments > 1;
    }

    function updateSendEnabled() {
        sendBtn.disabled = !(inputEl.value.trim().length > 0 || pendingAtts.length > 0);
    }

    async function uploadAttachment(file) {
        const fd = new FormData();
        fd.append('file', file);

        const placeholder = document.createElement('div');
        placeholder.className = 'msg-attach-chip is-uploading';
        placeholder.textContent = file.name;
        attachRow.appendChild(placeholder);

        try {
            const t = await mintCsrf();
            const res = await fetch(API_BASE + '/upload/media.php', {
                method: 'POST',
                credentials: 'include',
                headers: { 'X-Citadel-Client': CLIENT, 'X-CSRF-Token': t || '' },
                body: fd,
            });
            const data = await res.json();
            if (!res.ok || !data || data.status === 'error') {
                throw new Error((data && data.message) || 'Upload failed');
            }
            placeholder.remove();
            pendingAtts.push({
                token: data.token,
                url:   data.url,
                kind:  data.kind,
                mime:  data.mime,
                name:  data.name || file.name,
                size:  data.size || file.size,
            });
            renderPendingAtts();
            updateSendEnabled();
        } catch (err2) {
            placeholder.remove();
            toast(err2.message || 'Upload failed.', 'error');
        }
    }

    function renderPendingAtts() {
        attachRow.innerHTML = '';
        pendingAtts.forEach((a, i) => {
            const chip = document.createElement('div');
            chip.className = 'msg-attach-chip';
            chip.innerHTML = a.kind === 'image'
                ? `<img src="${escUrl(a.url)}" alt="">`
                : `<span>📎 ${esc(a.name)}</span>`;
            const rm = document.createElement('button');
            rm.type = 'button';
            rm.textContent = '×';
            rm.className = 'msg-attach-chip__rm';
            rm.addEventListener('click', () => {
                pendingAtts.splice(i, 1);
                renderPendingAtts();
                updateSendEnabled();
            });
            chip.appendChild(rm);
            attachRow.appendChild(chip);
        });
    }

    async function sendMessage() {
        const body = inputEl.value.trim();
        if (!body && pendingAtts.length === 0) return;
        if (!activeConvId) return;

        // Client-side pre-check before hitting the API
        if (pendingAtts.length > limits.message_max_attachments) {
            toast(
                `Messages are limited to ${limits.message_max_attachments} ` +
                `attachment(s) on your tier.`,
                'error'
            );
            return;
        }

        const idem = uuidHex();
        const attsToSend = pendingAtts.slice();

        const optimistic = {
            id: -Date.now(),
            conversation_id: activeConvId,
            sender_id: currentUser.id,
            body,
            deleted: false,
            encrypted: false,
            created_at: new Date().toISOString(),
            attachments: attsToSend,
        };
        messages.push(optimistic);
        threadBody.appendChild(renderMessage(optimistic));
        scrollToBottom();

        inputEl.value = '';
        inputEl.style.height = 'auto';
        pendingAtts = [];
        renderPendingAtts();
        updateSendEnabled();

        try {
            const data = await api('POST', '/messages/send.php', {
                conversation_id: activeConvId,
                body,
                attachment_tokens: attsToSend.map(a => a.token),
                idempotency_key: idem,
            });

            const el = threadBody.querySelector(`[data-msg-id="${optimistic.id}"]`);
            if (el) el.dataset.msgId = String(data.message_id);
            optimistic.id = data.message_id;
        } catch (e) {
            if (e.message === 'unauthenticated') return;
            toast(e.message || 'Could not send.', 'error');
            messages = messages.filter(x => x.id !== optimistic.id);
            threadBody.querySelector(`[data-msg-id="${optimistic.id}"]`)?.remove();
        }
    }

    /* ══════════════════════════════════════════════════════════════
     * STATUS
     * ================================================================ */

    function showLoading() {
        loadingEl.hidden = false;
        errorEl.hidden = true;
        shellEl.hidden = true;
    }
    function showError(msg) {
        loadingEl.hidden = true;
        errorEl.hidden = false;
        shellEl.hidden = true;
        errorTextEl.textContent = msg;
    }
    function showShell() {
        loadingEl.hidden = true;
        errorEl.hidden = true;
        shellEl.hidden = false;
    }

    /* ══════════════════════════════════════════════════════════════
     * BOOT
     * ================================================================ */

    async function boot() {
        showLoading();

        let user = null;
        try {
            user = await resolveCurrentUser();
        } catch (e) { if (e.message === 'unauthenticated') return; }

        if (!user) {
            const next = encodeURIComponent(location.pathname + location.search);
            window.location.href = `${LOGIN_URL}?next=${next}`;
            return;
        }

        currentUser = user;
        limits = resolveLimits(user);
        log('tier:', limits.tier);

        try {
            await loadConversations();
        } catch (e) {
            if (e.message === 'unauthenticated') return;
            showError(e.message || 'Could not load conversations.');
            return;
        }

        if (INITIAL_C > 0) {
            try { await openConversation(INITIAL_C); } catch (_) {}
        }

        showShell();
        startStream();

        window.addEventListener('beforeunload', stopStream);
    }

    retryBtn.addEventListener('click', boot);
    wireComposer();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

    log('boot scheduled');

})();