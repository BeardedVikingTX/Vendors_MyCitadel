/* ============================================================================
 * ███ CITIZENS.JS ███
 * MyCitadel — Citizens Directory
 * ----------------------------------------------------------------------------
 * Renders the paginated grid of Citizens, wires connection actions
 * (request / accept / deny / cancel / sever / block), and handles search
 * + filter state. Talks to /v1/users/list.php and the connections endpoints.
 * ========================================================================== */

(function () {
    'use strict';

    const root = document.querySelector('.citizens-root');
    if (!root) return;

    const API_BASE  = root.dataset.apiBase  || 'https://api.mycitadel.lol/v1';
    const CLIENT    = root.dataset.client   || 'browser/1.0.0';
    const LOGIN_URL = root.dataset.loginUrl || '/login';

    const DEFAULT_AVATAR    = 'https://mycitadel.lol/img/users/default/avatar.png';
    const DEFAULT_BANNER    = 'https://mycitadel.lol/img/users/default/banner.png';
    const DEFAULT_WALLPAPER = 'https://mycitadel.lol/img/users/default/wallpaper.png';

    /* ── DOM ────────────────────────────────────────────────────── */
    const searchEl   = document.getElementById('citizens-search');
    const filterBtns = document.querySelectorAll('.citizens-toolbar__filters .chip');
    const statusEl   = document.getElementById('citizens-status');
    const gridEl     = document.getElementById('citizens-grid');
    const emptyEl    = document.getElementById('citizens-empty');
    const moreEl     = document.getElementById('citizens-more');
    const moreBtn    = document.getElementById('citizens-more-btn');
    const toastLayer = document.getElementById('citizens-toast-layer');

    /* ── State ──────────────────────────────────────────────────── */
    let currentUser  = null;
    let csrfToken    = null;
    let csrfPromise  = null;
    let searchTerm   = '';
    let filterMode   = 'all';        // all | exclude_connected
    let offset       = 0;
    const PAGE_SIZE  = 24;
    let loading      = false;
    let searchTimer  = null;

    const log  = (...a) => console.log('[citizens]', ...a);
    const warn = (...a) => console.warn('[citizens]', ...a);
    const err  = (...a) => console.error('[citizens]', ...a);

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

    function initialsOf(name) {
        if (!name) return '?';
        const parts = String(name).trim().split(/\s+/);
        if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
        return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }

    function toast(msg, kind = 'info', ms = 2600) {
        if (!toastLayer) return;
        const el = document.createElement('div');
        el.className = 'citizens-toast citizens-toast--' + kind;
        el.textContent = msg;
        toastLayer.appendChild(el);
        requestAnimationFrame(() => el.classList.add('is-visible'));
        setTimeout(() => {
            el.classList.remove('is-visible');
            setTimeout(() => el.remove(), 220);
        }, ms);
    }

    function setStatus(msg) {
        if (!statusEl) return;
        if (!msg) { statusEl.hidden = true; statusEl.textContent = ''; return; }
        statusEl.hidden = false;
        statusEl.textContent = msg;
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
            if (!t) throw new Error('Could not establish a secure session.');
            headers['X-CSRF-Token'] = t;
        }

        let res;
        try {
            res = await fetch(API_BASE + path, {
                method, credentials: 'include', headers,
                body: hasBody ? JSON.stringify(body) : undefined,
            });
        } catch (e) {
            throw new Error('Network error: ' + (e.message || 'unknown'));
        }

        let data = null;
        try { data = await res.json(); } catch (_) {}

        if (data && typeof data.csrf_token === 'string' && data.csrf_token.length > 0) {
            csrfToken = data.csrf_token;
        }

        if (res.status === 401) {
            const next = encodeURIComponent(location.pathname + location.search);
            window.location.href = `${LOGIN_URL}?next=${next}`;
            throw new Error('unauthenticated');
        }

        if (!res.ok) {
            const e = new Error((data && data.message) || ('Request failed: ' + res.status));
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
     * BOOT — resolve current user
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
     * CARD RENDER
     * ================================================================ */

    function renderCard(u) {
        const card = document.createElement('article');
        card.className = 'citizen-card';
        card.dataset.userId = u.id;

        const avatar  = u.avatar_url  || DEFAULT_AVATAR;
        const banner  = u.banner_url  || DEFAULT_BANNER;
        const wallpaper = u.wallpaper_url || DEFAULT_WALLPAPER;

        const displayName = u.display_name || u.username;
        const handle = '@' + u.username;
        const tagline = u.tagline ? esc(u.tagline) : '';

        // Rep + badges line
        const statBits = [];
        if (u.reputation > 0) statBits.push(`★ ${u.reputation.toLocaleString()}`);
        if (u.badge_count > 0) statBits.push(`${u.badge_count} badge${u.badge_count === 1 ? '' : 's'}`);
        const statsLine = statBits.join(' · ');

        card.innerHTML = `
            <div class="citizen-card__wallpaper" style="background-image:url('${esc(wallpaper)}')"></div>
            <div class="citizen-card__banner" style="background-image:url('${esc(banner)}')"></div>
            <div class="citizen-card__overlay"></div>
            <div class="citizen-card__body">
                <div class="citizen-card__avatar">
                    <img src="${esc(avatar)}" alt="" onerror="this.src='${esc(DEFAULT_AVATAR)}'">
                </div>
                <div class="citizen-card__meta">
                    <h3 class="citizen-card__name">${esc(displayName)}</h3>
                    <p class="citizen-card__handle">${esc(handle)}</p>
                    ${tagline ? `<p class="citizen-card__tagline">${tagline}</p>` : ''}
                    ${statsLine ? `<p class="citizen-card__stats">${esc(statsLine)}</p>` : ''}
                </div>
            </div>
            <div class="citizen-card__actions" data-actions></div>
        `;

        renderActions(card.querySelector('[data-actions]'), u);
        return card;
    }

    function renderActions(container, u) {
        container.innerHTML = '';
        const state = u.connection_state || 'none';

        const addBtn = (label, cls, handler) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'btn-citizen ' + cls;
            b.textContent = label;
            b.addEventListener('click', handler);
            container.appendChild(b);
            return b;
        };

        if (state === 'connected') {
            addBtn('View Profile', 'btn-citizen--cyan', () => {
                window.location.href = '/users/view.php?id=' + u.id;
            });
            addBtn('Sever', 'btn-citizen--danger', () => confirmSever(container, u));
            addBtn('Message', 'btn-citizen--gold', () => openConversation(container, u));
        } else if (state === 'pending_out') {
            addBtn('Request Sent', 'btn-citizen--muted', () => {});
            addBtn('Cancel', 'btn-citizen--ghost', () => cancelRequest(container, u));
        } else if (state === 'pending_in') {
            addBtn('Accept', 'btn-citizen--cyan', () => acceptRequest(container, u));
            addBtn('Deny', 'btn-citizen--danger', () => denyRequest(container, u));
        } else {
            addBtn('Request Connection', 'btn-citizen--cyan', () => requestConnection(container, u));
            addBtn('Hide Me', 'btn-citizen--ghost', () => confirmHide(container, u));
        }
    }

    /* ══════════════════════════════════════════════════════════════
     * ACTIONS
     * ================================================================ */

    async function requestConnection(container, u) {
        setBusy(container, true);
        try {
            await api('POST', '/connections/request.php', { user_id: u.id });
            u.connection_state = 'pending_out';
            renderActions(container, u);
            toast('Request sent to ' + u.username + '.', 'success');
        } catch (e) {
            setBusy(container, false);
            if (e.code === 'incoming_request_exists') {
                u.connection_state = 'pending_in';
                renderActions(container, u);
                toast('They already sent you a request — check it here.', 'info');
            } else {
                toast(e.message || 'Could not send request.', 'error');
            }
        }
    }

    async function acceptRequest(container, u) {
        setBusy(container, true);
        try {
            await api('POST', '/connections/accept.php', { user_id: u.id });
            u.connection_state = 'connected';
            renderActions(container, u);
            toast('You are now connected with ' + u.username + '. +25 rep.', 'success');
        } catch (e) {
            setBusy(container, false);
            toast(e.message || 'Could not accept.', 'error');
        }
    }

    async function denyRequest(container, u) {
        setBusy(container, true);
        try {
            await api('POST', '/connections/block.php', { user_id: u.id });
            // Deny = block per the API semantics — remove the card entirely
            removeCard(u.id);
            toast('Request declined.', 'info');
        } catch (e) {
            setBusy(container, false);
            toast(e.message || 'Could not deny.', 'error');
        }
    }

    async function cancelRequest(container, u) {
        setBusy(container, true);
        try {
            await api('POST', '/connections/block.php', { user_id: u.id });
            // Cancel = block under the hood; remove the card from view
            removeCard(u.id);
            toast('Request cancelled.', 'info');
        } catch (e) {
            setBusy(container, false);
            toast(e.message || 'Could not cancel.', 'error');
        }
    }

    /**
     * Open (or create) a direct conversation with the target user and
     * navigate to the messages page. The API enforces the connection gate
     * server-side; we only get here from the "connected" state so it will
     * always succeed unless the server has stale state.
     */
    async function openConversation(container, u) {
        setBusy(container, true);
        try {
            const data = await api('POST', '/messages/open.php', { to: u.id });
            if (!data || !data.conversation_id) {
                throw new Error('Could not open conversation.');
            }
            window.location.href = '/messages?c=' + data.conversation_id;
        } catch (e) {
            setBusy(container, false);
            if (e.code === 'not_connected') {
                toast('You must be connected to message this user.', 'error');
            } else {
                toast(e.message || 'Could not open conversation.', 'error');
            }
        }
    }    

    function confirmSever(container, u) {
        if (!confirm('Sever connection with ' + u.username + '? This destroys all messages and hides you from each other.')) {
            return;
        }
        setBusy(container, true);
        api('POST', '/connections/block.php', { user_id: u.id })
            .then(() => {
                removeCard(u.id);
                toast('Connection severed.', 'info');
            })
            .catch((e) => {
                setBusy(container, false);
                toast(e.message || 'Could not sever.', 'error');
            });
    }

    function confirmHide(container, u) {
        if (!confirm('Hide yourself from ' + u.username + '? You will no longer see each other.')) {
            return;
        }
        setBusy(container, true);
        api('POST', '/connections/block.php', { user_id: u.id })
            .then(() => {
                removeCard(u.id);
                toast('Hidden.', 'info');
            })
            .catch((e) => {
                setBusy(container, false);
                toast(e.message || 'Could not hide.', 'error');
            });
    }

    function setBusy(container, busy) {
        container.querySelectorAll('button').forEach(b => b.disabled = busy);
    }

    function removeCard(userId) {
        const card = gridEl.querySelector(`[data-user-id="${userId}"]`);
        if (!card) return;
        card.style.transition = 'opacity 220ms, transform 220ms';
        card.style.opacity = '0';
        card.style.transform = 'scale(0.96)';
        setTimeout(() => card.remove(), 240);
    }

    /* ══════════════════════════════════════════════════════════════
     * FEED LOADING
     * ================================================================ */

    async function loadPage({ reset = false } = {}) {
        if (loading) return;
        loading = true;
        if (reset) {
            offset = 0;
            gridEl.innerHTML = '';
            if (emptyEl) emptyEl.hidden = true;
    
            // Prepend "You" card so the user can always find their own profile
            if (currentUser) {
                gridEl.appendChild(renderSelfCard(currentUser));
            }
        }

        setStatus('Loading Citizens…');

        const params = new URLSearchParams();
        params.set('limit',  String(PAGE_SIZE));
        params.set('offset', String(offset));
        if (searchTerm) params.set('q', searchTerm);
        if (filterMode === 'exclude_connected') params.set('exclude_connected', '1');

        try {
            const data = await api('GET', '/users/list.php?' + params.toString());
            const users = data.users || [];

            if (reset && users.length === 0) {
                if (emptyEl) emptyEl.hidden = false;
                if (moreEl)  moreEl.hidden  = true;
                setStatus('');
                return;
            }

            users.forEach(u => gridEl.appendChild(renderCard(u)));
            offset += users.length;

            if (moreEl) moreEl.hidden = !data.has_more;
            setStatus(data.total
                ? `${data.total.toLocaleString()} Citizen${data.total === 1 ? '' : 's'}`
                : '');
        } catch (e) {
            if (e.message === 'unauthenticated') return;
            err('load failed', e);
            setStatus('');
            toast(e.message || 'Could not load Citizens.', 'error');
        } finally {
            loading = false;
        }
    }

    /* ══════════════════════════════════════════════════════════════
     * WIRING
     * ================================================================ */

    function wireToolbar() {
        if (searchEl) {
            searchEl.addEventListener('input', () => {
                clearTimeout(searchTimer);
                searchTimer = setTimeout(() => {
                    searchTerm = searchEl.value.trim();
                    loadPage({ reset: true });
                }, 320);
            });
        }

        filterBtns.forEach(b => {
            b.addEventListener('click', () => {
                filterBtns.forEach(x => x.classList.remove('is-active'));
                b.classList.add('is-active');
                filterMode = b.dataset.filter || 'all';
                loadPage({ reset: true });
            });
        });

        if (moreBtn) moreBtn.addEventListener('click', () => loadPage({ reset: false }));
    }
    
    /* ══════════════════════════════════════════════════════════════
     * VIEW SELF CARD
     * ================================================================ */

    function renderSelfCard(u) {
        const card = document.createElement('article');
        card.className = 'citizen-card citizen-card--self';
        card.dataset.userId = u.id;
    
        const avatar    = u.avatar_url  || DEFAULT_AVATAR;
        const banner    = u.banner_url  || DEFAULT_BANNER;
        const wallpaper = u.wallpaper_url || DEFAULT_WALLPAPER;
    
        const displayName = u.display_name || u.username;
        const handle = '@' + u.username;
        const tagline = u.tagline ? esc(u.tagline) : '';
    
        const statBits = [];
        if (u.reputation > 0) statBits.push(`★ ${u.reputation.toLocaleString()}`);
        const statsLine = statBits.join(' · ');
    
        card.innerHTML = `
            <div class="citizen-card__wallpaper" style="background-image:url('${esc(wallpaper)}')"></div>
            <div class="citizen-card__banner" style="background-image:url('${esc(banner)}')"></div>
            <div class="citizen-card__overlay"></div>
            <div class="citizen-card__you-badge">YOU</div>
            <div class="citizen-card__body">
                <div class="citizen-card__avatar">
                    <img src="${esc(avatar)}" alt="" onerror="this.src='${esc(DEFAULT_AVATAR)}'">
                </div>
                <div class="citizen-card__meta">
                    <h3 class="citizen-card__name">${esc(displayName)}</h3>
                    <p class="citizen-card__handle">${esc(handle)}</p>
                    ${tagline ? `<p class="citizen-card__tagline">${tagline}</p>` : ''}
                    ${statsLine ? `<p class="citizen-card__stats">${esc(statsLine)}</p>` : ''}
                </div>
            </div>
            <div class="citizen-card__actions">
                <button type="button" class="btn-citizen btn-citizen--cyan" data-action="view-self">View Profile</button>
                <button type="button" class="btn-citizen btn-citizen--gold" data-action="edit-self">Edit Profile</button>
            </div>
        `;
    
        card.querySelector('[data-action="view-self"]').addEventListener('click', () => {
            window.location.href = '/users/view.php?id=' + u.id;
        });
    
        card.querySelector('[data-action="edit-self"]').addEventListener('click', () => {
            window.location.href = '/users/edit.php';
        });
    
        return card;
    }

    /* ══════════════════════════════════════════════════════════════
     * BOOT
     * ================================================================ */

    async function boot() {
        try {
            currentUser = await resolveCurrentUser();
        } catch (e) {
            if (e.message === 'unauthenticated') return;
            err('user resolve failed', e);
        }
        if (!currentUser) {
            const next = encodeURIComponent(location.pathname + location.search);
            window.location.href = `${LOGIN_URL}?next=${next}`;
            return;
        }

        wireToolbar();
        loadPage({ reset: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

})();