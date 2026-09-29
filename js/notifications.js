/* ============================================================================
 * ███ NOTIFICATIONS.JS ███
 * MyCitadel — Notification center
 * ----------------------------------------------------------------------------
 * Loads /v1/notifications/list.php, renders each notification based on its
 * type, wires action buttons:
 *
 *   connection_request  → [Accept] [Deny]
 *   connection_accepted → informational + [View Profile]
 *   connection_denied   → informational (target is now hidden)
 *   comment_created     → [View Post]
 *   comment_reply       → [View Post]
 *   reaction_post       → [View Post]
 *   reaction_comment    → [View Post]
 *   (default)           → generic card with optional link
 *
 * All API strings are escaped via esc() before DOM insertion.
 * Only a real HTTP 401 redirects to /login.
 * ========================================================================== */

(function () {
    'use strict';

    const root = document.querySelector('.notif-root');
    if (!root) return;

    const API_BASE  = root.dataset.apiBase  || 'https://api.mycitadel.lol/v1';
    const CLIENT    = root.dataset.client   || 'browser/1.0.0';
    const LOGIN_URL = root.dataset.loginUrl || '/login';

    const DEFAULT_AVATAR = 'https://mycitadel.lol/img/users/default/avatar.png';

    /* ── DOM ────────────────────────────────────────────────────── */
    const loadingEl    = document.getElementById('notif-loading');
    const errorEl      = document.getElementById('notif-error');
    const errorMsgEl   = document.getElementById('notif-error-msg');
    const retryBtn     = document.getElementById('notif-retry');
    const listEl       = document.getElementById('notif-list');
    const emptyEl      = document.getElementById('notif-empty');
    const markAllBtn   = document.getElementById('notif-mark-all');
    const toastLayer   = document.getElementById('notif-toast-layer');
    const tabs         = document.querySelectorAll('.notif-tab');

    /* ── State ──────────────────────────────────────────────────── */
    let currentUser  = null;
    let csrfToken    = null;
    let csrfPromise  = null;
    let activeTab    = 'all';
    let notifications = [];

    const log  = (...a) => console.log('[notif]', ...a);
    const warn = (...a) => console.warn('[notif]', ...a);
    const err  = (...a) => console.error('[notif]', ...a);

    /* ══════════════════════════════════════════════════════════════
     * UTILITIES
     * ================================================================ */

    function esc(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function escUrl(u) {
        if (!u || typeof u !== 'string') return '';
        if (!/^https?:\/\//i.test(u)) return '';
        if (/['"()\s]/.test(u)) return '';
        return u;
    }

    function fmtRelative(iso) {
        if (!iso) return '—';
        const diff = (Date.now() - new Date(iso).getTime()) / 1000;
        if (diff < 60)     return 'just now';
        if (diff < 3600)   return Math.floor(diff / 60) + 'm ago';
        if (diff < 86400)  return Math.floor(diff / 3600) + 'h ago';
        if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
        return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }

    function initialsOf(name) {
        if (!name) return '?';
        const parts = String(name).trim().split(/\s+/);
        if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
        return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }

    function toast(msg, kind = 'info', ms = 2600) {
        if (!toastLayer) return;
        const el = document.createElement('div');
        el.className = 'notif-toast notif-toast--' + kind;
        el.textContent = msg;
        toastLayer.appendChild(el);
        requestAnimationFrame(() => el.classList.add('is-visible'));
        setTimeout(() => {
            el.classList.remove('is-visible');
            setTimeout(() => el.remove(), 220);
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
        const hasBody = body !== undefined && body !== null;
        if (hasBody) headers['Content-Type'] = 'application/json';

        if (method !== 'GET') {
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
                (data && data.message) || 'Unexpected response.'
            );
        }
        return data;
    }

    function makeError(code, message) {
        const e = new Error(message);
        e.code = code;
        return e;
    }

    /* ══════════════════════════════════════════════════════════════
     * CURRENT USER
     * ================================================================ */

    async function resolveCurrentUser() {
        try {
            if (window.Citadel && window.Citadel.user) return window.Citadel.user;
        } catch (_) {}
        const u = await new Promise((resolve) => {
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
            }, 2500);
        });
        if (u) return u;
        try {
            const data = await api('GET', '/users/me.php');
            return data.user || null;
        } catch (e) {
            if (e.code === 'unauthenticated') throw e;
            return null;
        }
    }

    /* ══════════════════════════════════════════════════════════════
     * TYPE-TO-RENDER MAPPING
     * ----------------------------------------------------------------
     * Each entry returns:
     *   { icon, accent, text (html), actions (array of button specs) }
     * Actions: { label, style, onClick(el, notif, actionsContainer) }
     * ================================================================ */

    function buildNotification(n) {
        const actor = n.actor;
        const actorName = actor ? (actor.display_name || actor.username) : 'Someone';
        const actorHandle = actor ? ('@' + actor.username) : '';
        const actorId = actor ? actor.id : null;

        // payload may be null, an object, or a JSON string depending on API
        let payload = n.payload;
        if (typeof payload === 'string') {
            try { payload = JSON.parse(payload); } catch (_) { payload = null; }
        }
        payload = payload || {};

        const postId = payload.post_id || payload.postId || null;
        const viewPostUrl = postId ? ('/posts/view.php?id=' + postId) : null;
        const viewUserUrl = actorId ? ('/users/view.php?id=' + actorId) : null;

        /* ── connection_request ─────────────────────────────────── */
        if (n.type === 'connection_request') {
            const intro = payload.message
                ? `<p class="notif-item__quote">"${esc(payload.message)}"</p>`
                : '';
            return {
                icon: '⚔',
                accent: 'cyan',
                html: `
                    <p class="notif-item__line">
                        <strong>${esc(actorName)}</strong>
                        <span class="notif-handle">${esc(actorHandle)}</span>
                        wants to connect with you.
                    </p>
                    ${intro}
                `,
                actions: [
                    {
                        label: 'Accept',
                        style: 'cyan',
                        handler: (ctx) => acceptRequest(ctx, actorId, actorName),
                    },
                    {
                        label: 'Deny',
                        style: 'danger',
                        handler: (ctx) => denyRequest(ctx, actorId, actorName),
                    },
                ],
            };
        }

        /* ── connection_accepted ────────────────────────────────── */
        if (n.type === 'connection_accepted') {
            return {
                icon: '✓',
                accent: 'success',
                html: `
                    <p class="notif-item__line">
                        <strong>${esc(actorName)}</strong>
                        <span class="notif-handle">${esc(actorHandle)}</span>
                        accepted your connection request.
                    </p>
                `,
                actions: viewUserUrl ? [
                    { label: 'View Profile', style: 'cyan', href: viewUserUrl },
                ] : [],
            };
        }

        /* ── connection_denied ──────────────────────────────────── */
        if (n.type === 'connection_denied') {
            return {
                icon: '✗',
                accent: 'muted',
                html: `
                    <p class="notif-item__line">
                        Your connection request was not accepted.
                    </p>
                `,
                actions: [],
            };
        }

        /* ── comment notifications ──────────────────────────────── */
        if (n.type === 'comment_created' || n.type === 'comment_reply'
            || n.type === 'post_comment' || n.type === 'comment') {
            const preview = payload.comment_preview || payload.preview || null;
            return {
                icon: '💬',
                accent: 'rune',
                html: `
                    <p class="notif-item__line">
                        <strong>${esc(actorName)}</strong>
                        <span class="notif-handle">${esc(actorHandle)}</span>
                        commented on your post.
                    </p>
                    ${preview ? `<p class="notif-item__quote">"${esc(preview)}"</p>` : ''}
                `,
                actions: viewPostUrl ? [
                    { label: 'View Post', style: 'cyan', href: viewPostUrl },
                ] : [],
            };
        }

        /* ── reaction notifications ─────────────────────────────── */
        if (n.type === 'reaction_post' || n.type === 'post_reaction'
            || n.type === 'reaction_comment' || n.type === 'comment_reaction'
            || n.type === 'reaction') {

            const reaction = payload.reaction || 'reacted to';
            const reactionIcon = ({
                like: '👍', heart: '❤️', dislike: '👎', angry: '😠',
            })[reaction] || '★';
            const targetNoun = n.type.includes('comment') ? 'comment' : 'post';

            return {
                icon: reactionIcon,
                accent: 'gold',
                html: `
                    <p class="notif-item__line">
                        <strong>${esc(actorName)}</strong>
                        <span class="notif-handle">${esc(actorHandle)}</span>
                        reacted to your ${esc(targetNoun)}.
                    </p>
                `,
                actions: viewPostUrl ? [
                    { label: 'View Post', style: 'cyan', href: viewPostUrl },
                ] : [],
            };
        }

        /* ── fallback ───────────────────────────────────────────── */
        return {
            icon: '◈',
            accent: 'muted',
            html: `
                <p class="notif-item__line">${esc(n.title || 'Notification')}</p>
                ${n.body ? `<p class="notif-item__sub">${esc(n.body)}</p>` : ''}
            `,
            actions: n.link ? [
                { label: 'Open', style: 'cyan', href: n.link },
            ] : [],
        };
    }

    /* ══════════════════════════════════════════════════════════════
     * RENDER
     * ================================================================ */

    function renderNotification(n) {
        const spec = buildNotification(n);
        const avatarUrl = (n.actor && n.actor.avatar_url)
            ? escUrl(n.actor.avatar_url) || DEFAULT_AVATAR
            : DEFAULT_AVATAR;
        const actorName = n.actor ? (n.actor.display_name || n.actor.username) : '?';

        const card = document.createElement('article');
        card.className = 'notif-item notif-item--' + spec.accent;
        if (!n.read) card.classList.add('notif-item--unread');
        card.dataset.notifId = n.id;

        card.innerHTML = `
            <div class="notif-item__icon">${esc(spec.icon)}</div>
            <div class="notif-item__avatar">
                <img src="${avatarUrl}" alt=""
                     onerror="this.parentNode.innerHTML='<span>${esc(initialsOf(actorName))}</span>'">
            </div>
            <div class="notif-item__body">
                ${spec.html}
                <p class="notif-item__time">${esc(fmtRelative(n.created_at))}</p>
            </div>
            <div class="notif-item__actions" data-actions></div>
        `;

        // Wire actions
        const actionsEl = card.querySelector('[data-actions]');
        spec.actions.forEach(a => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'notif-btn notif-btn--' + a.style;
            btn.textContent = a.label;

            if (a.href) {
                btn.addEventListener('click', () => {
                    window.location.href = a.href;
                });
            } else if (a.handler) {
                btn.addEventListener('click', () => {
                    const ctx = {
                        card,
                        notification: n,
                        setBusy: (busy) => {
                            card.querySelectorAll('button').forEach(b => b.disabled = busy);
                        },
                    };
                    a.handler(ctx);
                });
            }

            actionsEl.appendChild(btn);
        });

        // Click anywhere else on the card → mark read + follow link
        card.addEventListener('click', (e) => {
            if (e.target.closest('button')) return;
            markRead(n.id);
        });

        return card;
    }

    /* ══════════════════════════════════════════════════════════════
     * ACTIONS
     * ================================================================ */

    async function acceptRequest(ctx, actorId, actorName) {
        if (!actorId) return;
        ctx.setBusy(true);
        try {
            await api('POST', '/connections/accept.php', { user_id: actorId });
    
            // Belt-and-suspenders: also delete the notification itself, in case
            // the server-side cleanup in accept.php is disabled or slow.
            try {
                await api('POST', '/notifications/delete.php', { id: ctx.notification.id });
            } catch (_) { /* non-fatal — the server should have cleaned it */ }
    
            toast('You are now connected with ' + actorName + '. +25 rep.', 'success');
            removeCard(ctx.card);
            // Also drop it from our in-memory array so tab switches don't
            // resurrect it from stale data.
            notifications = notifications.filter(n => n.id !== ctx.notification.id);
        } catch (e) {
            if (e.code === 'unauthenticated') return;
            ctx.setBusy(false);
            toast(e.message || 'Could not accept.', 'error');
        }
    }

    async function denyRequest(ctx, actorId, actorName) {
        if (!actorId) return;
        if (!confirm('Deny this request? You will not see each other again.')) return;
        ctx.setBusy(true);
        try {
            await api('POST', '/connections/block.php', { user_id: actorId });
    
            try {
                await api('POST', '/notifications/delete.php', { id: ctx.notification.id });
            } catch (_) { /* non-fatal */ }
    
            toast('Request denied.', 'info');
            removeCard(ctx.card);
            notifications = notifications.filter(n => n.id !== ctx.notification.id);
        } catch (e) {
            if (e.code === 'unauthenticated') return;
            ctx.setBusy(false);
            toast(e.message || 'Could not deny.', 'error');
        }
    }

    function removeCard(card) {
        card.style.transition = 'opacity 220ms, transform 220ms';
        card.style.opacity = '0';
        card.style.transform = 'scale(0.97)';
        setTimeout(() => {
            card.remove();
            if (!listEl.querySelector('.notif-item')) {
                emptyEl.hidden = false;
                markAllBtn.hidden = true;
            }
        }, 240);
    }

    /* ══════════════════════════════════════════════════════════════
     * MARK READ
     * ================================================================ */

    async function markRead(id) {
        const card = listEl.querySelector(`[data-notif-id="${id}"]`);
        if (!card || !card.classList.contains('notif-item--unread')) return;

        // Optimistic UI — remove unread state immediately
        card.classList.remove('notif-item--unread');

        try {
            await api('POST', '/notifications/read.php', { id });
            // Update local state
            const n = notifications.find(x => x.id === id);
            if (n) n.read = true;
            updateMarkAllVisibility();
        } catch (e) {
            if (e.code === 'unauthenticated') return;
            // Roll back on failure
            card.classList.add('notif-item--unread');
            warn('mark read failed', e);
        }
    }

    async function markAllRead() {
        markAllBtn.disabled = true;
        try {
            await api('POST', '/notifications/read.php', { all: true });
            listEl.querySelectorAll('.notif-item--unread').forEach(c => {
                c.classList.remove('notif-item--unread');
            });
            notifications.forEach(n => { n.read = true; });
            markAllBtn.hidden = true;
            toast('All marked as read.', 'success', 1600);
        } catch (e) {
            if (e.code === 'unauthenticated') return;
            toast(e.message || 'Could not mark all.', 'error');
        } finally {
            markAllBtn.disabled = false;
        }
    }

    function updateMarkAllVisibility() {
        const hasUnread = notifications.some(n => !n.read);
        markAllBtn.hidden = !hasUnread;
    }

    /* ══════════════════════════════════════════════════════════════
     * LOAD
     * ================================================================ */

    async function loadNotifications() {
        showLoading();
        const unreadOnly = activeTab === 'unread' ? '1' : '0';
        try {
            const data = await api(
                'GET',
                '/notifications/list.php?unread_only=' + unreadOnly + '&limit=50'
            );
            notifications = data.notifications || [];
            renderAll();
        } catch (e) {
            if (e.code === 'unauthenticated') return;
            showError(e.message || 'Could not load notifications.');
        }
    }

    function renderAll() {
        listEl.innerHTML = '';
        listEl.hidden = false;

        if (notifications.length === 0) {
            emptyEl.hidden = false;
            updateMarkAllVisibility();
            hideLoading();
            return;
        }

        emptyEl.hidden = true;
        notifications.forEach(n => listEl.appendChild(renderNotification(n)));
        updateMarkAllVisibility();
        hideLoading();
    }

    /* ══════════════════════════════════════════════════════════════
     * STATUS
     * ================================================================ */

    function showLoading() {
        loadingEl.hidden = false;
        errorEl.hidden = true;
        listEl.hidden = true;
        emptyEl.hidden = true;
    }

    function hideLoading() {
        loadingEl.hidden = true;
    }

    function showError(msg) {
        loadingEl.hidden = true;
        listEl.hidden = true;
        emptyEl.hidden = true;
        errorEl.hidden = false;
        errorMsgEl.textContent = msg;
    }

    /* ══════════════════════════════════════════════════════════════
     * WIRING
     * ================================================================ */

    function wireTabs() {
        tabs.forEach(t => {
            t.addEventListener('click', () => {
                tabs.forEach(x => x.classList.remove('is-active'));
                t.classList.add('is-active');
                activeTab = t.dataset.tab || 'all';
                loadNotifications();
            });
        });
    }

    /* ══════════════════════════════════════════════════════════════
     * BOOT
     * ================================================================ */

    async function boot() {
        try {
            currentUser = await resolveCurrentUser();
        } catch (e) {
            if (e.code === 'unauthenticated') return;
            err('resolve user failed', e);
        }
        if (!currentUser) {
            const next = encodeURIComponent(location.pathname + location.search);
            window.location.href = `${LOGIN_URL}?next=${next}`;
            return;
        }

        wireTabs();
        markAllBtn.addEventListener('click', markAllRead);
        retryBtn.addEventListener('click', loadNotifications);

        loadNotifications();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

    log('boot scheduled');

})();