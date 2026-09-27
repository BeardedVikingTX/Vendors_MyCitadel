/* ============================================================================
 * ███ CITADEL-APP.JS ███
 * MyCitadel — Frontend API Client
 * ----------------------------------------------------------------------------
 * Subdomain : https://vendors.mycitadel.lol/js/citadel-app.js
 * Author    : Bearded Viking (https://beardedviking.org)
 * Project   : MyCitadel (https://mycitadel.lol)
 * License   : MIT
 *
 * PURPOSE
 *   One clean interface for every page to talk to the API. Handles CSRF
 *   lifecycle, session cookies, the required client header, automatic
 *   401 redirects, and response envelope parsing.
 *
 * ZERO DEPENDENCIES. Never uses innerHTML. Never stores secrets in JS.
 * ========================================================================== */

(function (window, document) {
    'use strict';

    /* ══════════════════════════════════════════════════════════════════ */
    const CONFIG = {
        apiBase: 'https://api.mycitadel.lol/v1',
        clientHeader: { 'X-Citadel-Client': 'browser/1.0.0' },
        loginUrl: '/login.html',
        dashboardUrl: '/dashboard.html',
        debug: false,
    };

    let csrfToken = null;
    let currentUser = null;

    /* ══════════════════════════════════════════════════════════════════ */
    function log(...args) {
        if (CONFIG.debug) console.log('%c[Citadel]', 'color:#00e5ff', ...args);
    }

    /* ══════════════════════════════════════════════════════════════════
     * CSRF TOKEN
     * ════════════════════════════════════════════════════════════════ */

    async function fetchCsrf() {
        const res = await fetch(CONFIG.apiBase + '/auth/csrf.php', {
            credentials: 'include',
            headers: CONFIG.clientHeader,
        });
        if (!res.ok) throw new Error('Could not fetch CSRF token (HTTP ' + res.status + ')');
        const data = await res.json();
        csrfToken = data.token || null;
        log('CSRF token fetched');
        return csrfToken;
    }

    function ensureCsrf() {
        if (csrfToken) return Promise.resolve(csrfToken);
        return fetchCsrf();
    }

    /* ══════════════════════════════════════════════════════════════════
     * CORE REQUEST
     * ════════════════════════════════════════════════════════════════ */

    async function request(method, path, body = null, options = {}) {
        const url = CONFIG.apiBase + path;
        const methodUpper = method.toUpperCase();
        const isSafe = ['GET', 'HEAD', 'OPTIONS'].includes(methodUpper);

        const headers = Object.assign({}, CONFIG.clientHeader, options.headers || {});
        if (!isSafe) {
            await ensureCsrf();
            if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
        }

        let bodyToSend = undefined;
        if (body !== null && body !== undefined) {
            if (body instanceof FormData || body instanceof Blob) {
                bodyToSend = body;
            } else {
                headers['Content-Type'] = 'application/json';
                bodyToSend = JSON.stringify(body);
            }
        }

        let res;
        try {
            res = await fetch(url, {
                method: methodUpper,
                credentials: 'include',
                headers: headers,
                body: bodyToSend,
            });
        } catch (err) {
            log('Network error', err);
            throw new Error('Network error. Check your connection.');
        }

        let data;
        try {
            data = await res.json();
        } catch (err) {
            log('Non-JSON response from ' + path, res.status);
            throw new Error('Server returned an unexpected response.');
        }

        // Auto-consume rotated CSRF token
        if (data && typeof data.csrf_token === 'string' && data.csrf_token.length > 0) {
            csrfToken = data.csrf_token;
            log('CSRF token rotated by server');
        }

        // Global 401 handling
        if (res.status === 401) {
            log('401 on ' + path + ' — clearing session');
            currentUser = null;
            if (!options.silentAuthRedirect) {
                if (!window.location.pathname.endsWith(CONFIG.loginUrl)) {
                    const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
                    window.location.href = CONFIG.loginUrl + '?next=' + returnTo;
                }
            }
        }

        if (!data || typeof data.status !== 'string') {
            throw new Error('Malformed response from server.');
        }

        if (data.status === 'error') {
            const err = new Error(data.message || 'Request failed.');
            err.code = data.code || 'unknown';
            err.httpStatus = res.status;
            err.payload = data;
            throw err;
        }

        return data;
    }

    function get(path, options) { return request('GET', path, null, options); }
    function post(path, body, options) { return request('POST', path, body, options); }
    function put(path, body, options) { return request('PUT', path, body, options); }
    function del(path, body, options) { return request('DELETE', path, body, options); }

    /* ══════════════════════════════════════════════════════════════════
     * SESSION
     * ════════════════════════════════════════════════════════════════ */

    async function fetchCurrentUser() {
        try {
            const data = await get('/users/me.php', { silentAuthRedirect: true });
            currentUser = data.user || null;
            return currentUser;
        } catch (err) {
            if (err.httpStatus === 401) {
                currentUser = null;
                return null;
            }
            throw err;
        }
    }

    async function bootstrap() {
        try { await ensureCsrf(); } catch (err) { log('CSRF bootstrap failed', err); }
        try { await fetchCurrentUser(); } catch (err) { log('User bootstrap failed', err); }
    }

    async function requireAuth() {
        const user = await fetchCurrentUser();
        if (!user) {
            const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
            window.location.href = CONFIG.loginUrl + '?next=' + returnTo;
            return null;
        }
        return user;
    }

    async function redirectIfAuthed() {
        const user = await fetchCurrentUser();
        if (user) {
            const next = new URLSearchParams(window.location.search).get('next');
            window.location.href = next || CONFIG.dashboardUrl;
            return true;
        }
        return false;
    }

    /* ══════════════════════════════════════════════════════════════════
     * PUBLIC API
     * ════════════════════════════════════════════════════════════════ */

    const Citadel = {
        get apiBase() { return CONFIG.apiBase; },
        get loginUrl() { return CONFIG.loginUrl; },
        get dashboardUrl() { return CONFIG.dashboardUrl; },

        get, post, put, del, request,
        getCsrf: () => csrfToken,
        refreshCsrf: fetchCsrf,

        bootstrap,
        fetchCurrentUser,
        requireAuth,
        redirectIfAuthed,
        get user() { return currentUser; },
        isLoggedIn: () => currentUser !== null,

        setDebug: (on) => { CONFIG.debug = !!on; },

        // DOM helpers — safe, never uses innerHTML
        el: (id) => document.getElementById(id),
        show: (id, msg, cls) => {
            const node = typeof id === 'string' ? document.getElementById(id) : id;
            if (!node) return;
            node.textContent = msg;
            node.className = 'citadel-msg' + (cls ? ' ' + cls : '');
            node.style.display = 'block';
        },
        hide: (id) => {
            const node = typeof id === 'string' ? document.getElementById(id) : id;
            if (node) node.style.display = 'none';
        },
        disable: (id, disabled) => {
            const node = typeof id === 'string' ? document.getElementById(id) : id;
            if (node) node.disabled = !!disabled;
        },
    };

    window.Citadel = Citadel;
    log('citadel-app.js loaded');

})(window, document);