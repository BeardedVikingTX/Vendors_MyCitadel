/* ============================================================================
 * ███ USER-VIEW.JS ███  v2
 * MyCitadel — Single profile viewer (full field coverage)
 * ========================================================================== */

(function () {
    'use strict';

    const root = document.querySelector('.user-view-root');
    if (!root) return;

    const API_BASE  = root.dataset.apiBase  || 'https://api.mycitadel.lol/v1';
    const CLIENT    = root.dataset.client   || 'browser/1.0.0';
    const LOGIN_URL = root.dataset.loginUrl || '/login';
    const TARGET_ID = parseInt(root.dataset.targetId, 10);

    const DEFAULT_AVATAR    = 'https://mycitadel.lol/img/users/default/avatar.png';
    const DEFAULT_BANNER    = 'https://mycitadel.lol/img/users/default/banner.png';

    const loadingEl   = document.getElementById('user-view-loading');
    const notFoundEl  = document.getElementById('user-view-notfound');
    const errorEl     = document.getElementById('user-view-error');
    const errorMsgEl  = document.getElementById('user-view-error-msg');
    const retryBtn    = document.getElementById('user-view-retry');
    const shellEl     = document.getElementById('user-view-shell');
    const heroEl      = document.getElementById('user-view-hero');
    const actionsEl   = document.getElementById('user-view-actions');
    const bodyEl      = document.getElementById('user-view-body');
    const badgesEl    = document.getElementById('user-view-badges');
    const toastLayer  = document.getElementById('user-view-toast-layer');

    let currentUser = null;
    let csrfToken   = null;
    let csrfPromise = null;

    const log = (...a) => console.log('[user-view]', ...a);
    const err = (...a) => console.error('[user-view]', ...a);

    /* ══════════════════════════════════════════════════════════════
     * SECURITY HELPERS
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

    function escAttrColor(c) {
        if (!c || typeof c !== 'string') return null;
        return /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : null;
    }

    /* ══════════════════════════════════════════════════════════════
     * FORMATTERS
     * ================================================================ */

    function initialsOf(name) {
        if (!name) return '?';
        const parts = String(name).trim().split(/\s+/);
        if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
        return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }

    function fmtDate(iso) {
        if (!iso) return '—';
        try {
            return new Date(iso).toLocaleDateString('en-US', {
                month: 'long', day: 'numeric', year: 'numeric'
            });
        } catch (_) { return '—'; }
    }

    function fmtNumber(n) { return (Number(n) || 0).toLocaleString('en-US'); }

    function humanize(s) {
        if (!s) return '';
        return String(s).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }

    function paragraphize(text) {
        if (!text) return '';
        return String(text)
            .split(/\n\n+/)
            .map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
            .join('');
    }

    function toast(msg, kind = 'info', ms = 2600) {
        if (!toastLayer) return;
        const el = document.createElement('div');
        el.className = 'user-view-toast user-view-toast--' + kind;
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
            } catch (_) {}
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
            if (!t) return { ok: false, status: 0, code: 'csrf_failed', message: 'Could not establish session.' };
            headers['X-CSRF-Token'] = t;
        }

        let res;
        try {
            res = await fetch(API_BASE + path, {
                method, credentials: 'include', headers,
                body: hasBody ? JSON.stringify(body) : undefined,
            });
        } catch (e) {
            return { ok: false, status: 0, code: 'network_error', message: 'Network error.' };
        }

        let data = null;
        try { data = await res.json(); } catch (_) {}
        if (data && typeof data.csrf_token === 'string' && data.csrf_token.length > 0) {
            csrfToken = data.csrf_token;
        }

        if (res.status === 401) {
            const next = encodeURIComponent(location.pathname + location.search);
            window.location.href = `${LOGIN_URL}?next=${next}`;
            return { ok: false, status: 401, code: 'unauthenticated', message: 'Session expired.' };
        }
        if (!res.ok) {
            return { ok: false, status: res.status,
                code: (data && data.code) || ('http_' + res.status),
                message: (data && data.message) || ('Failed: ' + res.status) };
        }
        if (!data || data.status === 'error') {
            return { ok: false, status: res.status,
                code: (data && data.code) || 'unknown',
                message: (data && data.message) || 'Unexpected response.' };
        }
        return { ok: true, data };
    }

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
        const r = await api('GET', '/users/me.php');
        return (r.ok && r.data.user) ? r.data.user : null;
    }

    /* ══════════════════════════════════════════════════════════════
     * HERO
     * ================================================================ */

    function renderHero(p) {
        const avatar    = escUrl(p.avatar_url) || DEFAULT_AVATAR;
        const banner    = escUrl(p.banner_url) || DEFAULT_BANNER;

        const displayName = p.display_name || p.username;
        const initials = esc(initialsOf(displayName));
        const pronouns = p.pronouns ? esc(p.pronouns) : '';
        const tagline = p.tagline ? esc(p.tagline) : '';

        const pills = [];
        if (p.is_self) pills.push({ cls: 'self', label: 'YOU' });
        if (p.connection_state === 'connected') pills.push({ cls: 'connected', label: 'CONNECTED' });
        if (p.is_premium) pills.push({ cls: 'premium', label: '★ PREMIUM' });

        const stats = [
            { label: 'Reputation', value: fmtNumber(p.reputation) },
            { label: 'Badges',     value: fmtNumber(p.badge_count) },
            { label: 'Posts',      value: fmtNumber(p.post_count) },
            { label: 'Connections', value: fmtNumber(p.connection_count) },
        ];

        heroEl.innerHTML = `
            <div class="user-view-banner" style="background-image:url('${banner}')">
                <div class="user-view-banner__overlay"></div>
            </div>

            <div class="user-view-identity">
                <div class="user-view-avatar">
                    <img src="${avatar}" alt=""
                         onerror="this.parentNode.innerHTML='<span class=&quot;user-view-avatar__init&quot;>${initials}</span>'">
                </div>

                <div class="user-view-identity__text">
                    <h1 class="user-view-name">${esc(displayName)}</h1>
                    <p class="user-view-handle">
                        @${esc(p.username)}
                        ${pronouns ? `<span class="user-view-pronouns">· ${pronouns}</span>` : ''}
                    </p>
                    ${tagline ? `<p class="user-view-tagline">${tagline}</p>` : ''}
                    ${pills.length ? `<div class="user-view-pills">${
                        pills.map(x => `<span class="user-view-pill user-view-pill--${x.cls}">${esc(x.label)}</span>`).join('')
                    }</div>` : ''}
                    <p class="user-view-member">Member since ${esc(fmtDate(p.member_since))}</p>
                </div>
            </div>

            <div class="user-view-stats">
                ${stats.map(s => `
                    <div class="user-view-stat">
                        <span class="user-view-stat__value">${esc(s.value)}</span>
                        <span class="user-view-stat__label">${esc(s.label)}</span>
                    </div>
                `).join('')}
            </div>
        `;
    }

    /* ══════════════════════════════════════════════════════════════
     * ACTIONS
     * ================================================================ */

    function renderActions(p) {
        actionsEl.innerHTML = '';
        actionsEl.hidden = false;

        const addBtn = (label, cls, handler) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'btn-citizen ' + cls;
            b.textContent = label;
            b.addEventListener('click', handler);
            actionsEl.appendChild(b);
        };

        const state = p.connection_state || 'none';

        if (p.is_self) {
            addBtn('Edit Profile', 'btn-citizen--gold', () => window.location.href = '/users/edit.php');
            addBtn('My Dashboard', 'btn-citizen--cyan', () => window.location.href = '/users/dashboard.php');
            return;
        }

        if (state === 'connected') {
            addBtn('Sever Connection', 'btn-citizen--danger', () => confirmSever(p));
            addBtn('Message', 'btn-citizen--gold', () => toast('Messaging is coming soon.', 'info'));
        } else if (state === 'pending_out') {
            addBtn('Request Sent', 'btn-citizen--muted', () => {});
            addBtn('Cancel Request', 'btn-citizen--ghost', () => confirmCancel(p));
        } else if (state === 'pending_in') {
            addBtn('Accept Request', 'btn-citizen--cyan', () => acceptRequest(p));
            addBtn('Deny', 'btn-citizen--danger', () => denyRequest(p));
        } else {
            addBtn('Request Connection', 'btn-citizen--cyan', () => requestConnection(p));
            addBtn('Hide Me', 'btn-citizen--ghost', () => confirmHide(p));
        }
    }

    /* ══════════════════════════════════════════════════════════════
     * BODY SECTIONS
     * ================================================================ */

    function section(title, contentHtml) {
        if (!contentHtml) return '';
        return `
            <section class="user-view-section">
                <h2 class="user-view-section__title">${esc(title)}</h2>
                <div class="user-view-section__body">${contentHtml}</div>
            </section>
        `;
    }

    function renderBody(p) {
        const parts = [];

        /* ── About (bio + motto) ──────────────────────────────── */
        const aboutParts = [];
        if (p.bio) aboutParts.push(paragraphize(p.bio));
        if (p.personal_motto) {
            aboutParts.push(`<blockquote class="user-view-quote">"${esc(p.personal_motto)}"</blockquote>`);
        }
        if (aboutParts.length) parts.push(section('About', aboutParts.join('')));

        /* ── Work ─────────────────────────────────────────────── */
        const w = p.work || {};
        const workRows = [];
        if (w.job_title) workRows.push(['Title', esc(w.job_title)]);
        if (w.company)   workRows.push(['Company', esc(w.company)]);
        if (w.years_at_company != null) workRows.push(['Years', esc(String(w.years_at_company))]);
        if (w.industry)  workRows.push(['Industry', esc(w.industry)]);
        if (w.education) workRows.push(['Education', esc(w.education)]);
        let workHtml = workRows.length ? detailList(workRows) : '';
        if (w.description) workHtml += paragraphize(w.description);
        parts.push(section('Work', workHtml));

        /* ── Personal ─────────────────────────────────────────── */
        const pe = p.personal || {};
        const personalRows = [];
        if (pe.relationship_status) personalRows.push(['Status', esc(humanize(pe.relationship_status))]);
        if (pe.has_kids === true)   personalRows.push(['Kids', esc(String(pe.kids_count || 'Yes'))]);
        if (pe.languages_spoken)    personalRows.push(['Languages', esc(pe.languages_spoken)]);
        if (pe.personality_type)    personalRows.push(['Personality', esc(pe.personality_type)]);
        if (pe.zodiac_sign)         personalRows.push(['Zodiac', esc(humanize(pe.zodiac_sign))]);
        if (pe.availability)        personalRows.push(['Availability', esc(humanize(pe.availability))]);
        if (pe.contact_preference)  personalRows.push(['Contact via', esc(humanize(pe.contact_preference))]);
        if (personalRows.length) parts.push(section('Personal', detailList(personalRows)));

        /* ── Interests ────────────────────────────────────────── */
        const it = p.interests || {};
        const intParts = [];
        if (it.hobbies) intParts.push(paragraphize(it.hobbies));
        if (Array.isArray(it.looking_for) && it.looking_for.length) {
            intParts.push(`<div class="user-view-chips">${
                it.looking_for.map(v => `<span class="user-view-chip">${esc(humanize(v))}</span>`).join('')
            }</div>`);
        }
        if (intParts.length) parts.push(section('Interests', intParts.join('')));

        /* ── Favorites ────────────────────────────────────────── */
        const fv = p.favorites || {};
        const favBlocks = [];
        const favoriteList = (title, arr) => {
            if (!Array.isArray(arr) || arr.length === 0) return '';
            return `
                <div class="user-view-fav-block">
                    <h3 class="user-view-fav-title">${esc(title)}</h3>
                    <ul class="user-view-fav-list">
                        ${arr.map(v => `<li>${esc(v)}</li>`).join('')}
                    </ul>
                </div>
            `;
        };
        favBlocks.push(favoriteList('Movies', fv.movies));
        favBlocks.push(favoriteList('Books', fv.books));
        favBlocks.push(favoriteList('Songs', fv.songs));
        favBlocks.push(favoriteList('Shows', fv.shows));
        favBlocks.push(favoriteList('Games', fv.games));
        if (fv.quotes) favBlocks.push(`
            <div class="user-view-fav-block">
                <h3 class="user-view-fav-title">Quote</h3>
                <blockquote class="user-view-quote">"${esc(fv.quotes)}"</blockquote>
            </div>
        `);
        if (fv.food) favBlocks.push(`
            <div class="user-view-fav-block">
                <h3 class="user-view-fav-title">Food</h3>
                <p>${esc(fv.food)}</p>
            </div>
        `);
        const favHtml = favBlocks.filter(Boolean).join('');
        parts.push(section('Favorites', favHtml));

        /* ── Links ────────────────────────────────────────────── */
        const lk = p.links || {};
        const linksByGroup = [
            { title: 'Primary', links: [
                ['Website', lk.website],
                ['GitHub', lk.github],
            ]},
            { title: 'Social', links: [
                ['Facebook',  lk.facebook],
                ['Twitter/X', lk.twitter],
                ['Instagram', lk.instagram],
                ['TikTok',    lk.tiktok],
                ['Threads',   lk.threads],
                ['LinkedIn',  lk.linkedin],
                ['YouTube',   lk.youtube],
            ]},
            { title: 'Federated', links: [
                ['Mastodon', lk.mastodon],
                ['Bluesky',  lk.bluesky],
            ]},
            { title: 'Gaming', links: [
                ['Steam', lk.steam],
                ['PSN',   lk.psn],
                ['Xbox',  lk.xbox],
            ]},
            { title: 'Streaming', links: [
                ['Twitch',  lk.twitch],
                ['Kick',    lk.kick],
                ['Podcast', lk.podcast],
            ]},
            { title: 'Developer & Security', links: [
                ['Stack Overflow', lk.stackoverflow],
                ['HackerOne',      lk.hackerone],
                ['Bugcrowd',       lk.bugcrowd],
                ['Intigriti',      lk.intigriti],
                ['YesWeHack',      lk.yeswehack],
            ]},
            { title: 'Contact', links: [
                ['Discord', lk.discord],
                ['Signal',  lk.signal],
            ]},
        ];

        const linkGroupsHtml = linksByGroup.map(g => {
            const items = g.links
                .filter(([, v]) => v && String(v).trim() !== '')
                .map(([label, v]) => {
                    const safe = escUrl(v);
                    if (safe) {
                        return `<li><span class="label">${esc(label)}</span>
                                   <a href="${esc(safe)}" target="_blank" rel="noopener noreferrer">${esc(v)}</a>
                                </li>`;
                    }
                    // Non-URL (Discord handle, Signal username, PGP key)
                    return `<li><span class="label">${esc(label)}</span>
                               <span class="mono">${esc(v)}</span>
                            </li>`;
                }).join('');
            if (!items) return '';
            return `
                <div class="user-view-links-group">
                    <h3 class="user-view-fav-title">${esc(g.title)}</h3>
                    <ul class="user-view-detail-list">${items}</ul>
                </div>
            `;
        }).join('');
        parts.push(section('Links', linkGroupsHtml));

        bodyEl.innerHTML = parts.filter(Boolean).join('');

        /* ── Limited-view fallback ────────────────────────────── */
        if (p.view === 'limited') {
            bodyEl.innerHTML = `
                <section class="user-view-section user-view-section--limited">
                    <p class="user-view-limited-msg">
                        <strong>${esc(p.display_name || p.username)}</strong> has
                        limited their profile to connections.
                        Request a connection to see more.
                    </p>
                </section>
            `;
        }
    }

    function detailList(rows) {
        if (!rows.length) return '';
        return `<ul class="user-view-detail-list">${
            rows.map(([label, value]) =>
                `<li><span class="label">${esc(label)}</span><span>${value}</span></li>`
            ).join('')
        }</ul>`;
    }

    /* ══════════════════════════════════════════════════════════════
     * BADGES
     * ================================================================ */

    function renderBadges(p) {
        const badges = Array.isArray(p.badges) ? p.badges : [];
        if (badges.length === 0) { badgesEl.hidden = true; return; }

        badgesEl.hidden = false;
        badgesEl.innerHTML = `
            <h2 class="user-view-section__title">Badges</h2>
            <div class="user-view-badges-grid">
                ${badges.map(b => {
                    const color = escAttrColor(b.color) || '#00e5ff';
                    return `
                        <div class="user-view-badge" style="--badge-color:${color}">
                            <span class="user-view-badge__tier">${esc((b.tier || '').toUpperCase())}</span>
                            <span class="user-view-badge__name">${esc(b.name || '')}</span>
                            <span class="user-view-badge__desc">${esc(b.description || '')}</span>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    }

    /* ══════════════════════════════════════════════════════════════
     * ACTIONS
     * ================================================================ */

    async function requestConnection(p) {
        setActionsBusy(true);
        const r = await api('POST', '/connections/request.php', { user_id: p.id });
        setActionsBusy(false);
        if (!r.ok) {
            if (r.code === 'incoming_request_exists') {
                toast('They already sent you a request.', 'info');
                load();
            } else toast(r.message, 'error');
            return;
        }
        toast('Request sent.', 'success');
        load();
    }

    async function acceptRequest(p) {
        setActionsBusy(true);
        const r = await api('POST', '/connections/accept.php', { user_id: p.id });
        setActionsBusy(false);
        if (!r.ok) { toast(r.message, 'error'); return; }
        toast('Connected. +25 reputation.', 'success');
        load();
    }

    async function denyRequest(p) {
        if (!confirm('Deny this request? You will not see each other again.')) return;
        setActionsBusy(true);
        const r = await api('POST', '/connections/block.php', { user_id: p.id });
        setActionsBusy(false);
        if (!r.ok) { toast(r.message, 'error'); return; }
        toast('Request denied.', 'info');
        window.location.href = '/users';
    }

    async function confirmCancel(p) {
        if (!confirm('Cancel this request?')) return;
        setActionsBusy(true);
        const r = await api('POST', '/connections/block.php', { user_id: p.id });
        setActionsBusy(false);
        if (!r.ok) { toast(r.message, 'error'); return; }
        toast('Request cancelled.', 'info');
        load();
    }

    async function confirmSever(p) {
        if (!confirm('Sever this connection? Destroys all messages and hides you from each other.')) return;
        setActionsBusy(true);
        const r = await api('POST', '/connections/block.php', { user_id: p.id });
        setActionsBusy(false);
        if (!r.ok) { toast(r.message, 'error'); return; }
        toast('Connection severed.', 'info');
        window.location.href = '/users';
    }

    async function confirmHide(p) {
        if (!confirm('Hide yourself from @' + p.username + '?')) return;
        setActionsBusy(true);
        const r = await api('POST', '/connections/block.php', { user_id: p.id });
        setActionsBusy(false);
        if (!r.ok) { toast(r.message, 'error'); return; }
        toast('Hidden.', 'info');
        window.location.href = '/users';
    }

    function setActionsBusy(busy) {
        actionsEl.querySelectorAll('button').forEach(b => b.disabled = busy);
    }

    /* ══════════════════════════════════════════════════════════════
     * STATUS + LOAD
     * ================================================================ */

    function showLoading() {
        loadingEl.hidden = false; notFoundEl.hidden = true;
        errorEl.hidden = true; shellEl.hidden = true;
    }
    function showNotFound() {
        loadingEl.hidden = true; notFoundEl.hidden = false;
        errorEl.hidden = true; shellEl.hidden = true;
    }
    function showError(msg) {
        loadingEl.hidden = true; notFoundEl.hidden = true;
        errorEl.hidden = false; shellEl.hidden = true;
        errorMsgEl.textContent = msg;
    }
    function showShell() {
        loadingEl.hidden = true; notFoundEl.hidden = true;
        errorEl.hidden = true; shellEl.hidden = false;
    }

    async function load() {
        showLoading();
        if (!TARGET_ID || TARGET_ID <= 0) { showNotFound(); return; }

        const r = await api('GET', '/users/view.php?id=' + TARGET_ID);

        if (!r.ok) {
            if (r.status === 404) { showNotFound(); return; }
            if (r.code === 'unauthenticated') return;
            showError(r.message || 'Could not load profile.');
            return;
        }
        const p = r.data.profile;
        if (!p) { showNotFound(); return; }
        p.view = r.data.view || 'full';

        renderHero(p);
        renderActions(p);
        renderBody(p);
        renderBadges(p);

        showShell();
        document.title = (p.display_name || p.username) + ' — MyCitadel';
    }

    async function boot() {
        try { currentUser = await resolveCurrentUser(); }
        catch (e) { err('user resolve failed', e); }
        if (!currentUser) {
            const next = encodeURIComponent(location.pathname + location.search);
            window.location.href = `${LOGIN_URL}?next=${next}`;
            return;
        }
        load();
    }

    if (retryBtn) retryBtn.addEventListener('click', load);

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

    log('boot scheduled for user id', TARGET_ID);

})();