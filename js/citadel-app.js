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
 *
 * LIFECYCLE
 *   1. Loaded (no defer, so window.Citadel is set synchronously).
 *   2. bootstrap() runs automatically: CSRF + /me in parallel.
 *   3. Dispatches 'citadel:ready' when done. Consumers (nav.js, etc.)
 *      listen for this event — no polling required.
 *   4. Citadel.ready is a Promise that resolves with the user (or null).
 *
 * EVENTS
 *   'citadel:ready'  →  { detail: { user: User|null } }
 *   'citadel:login'  →  { detail: { user: User } }
 *   'citadel:logout' →  { detail: {} }
 * ========================================================================== */

(function (window, document) {
    'use strict';

    /* ══════════════════════════════════════════════════════════════════
     * CONFIG
     * ================================================================ */
    const CONFIG = {
        apiBase:       'https://api.mycitadel.lol/v1',
        clientHeader:  { 'X-Citadel-Client': 'browser/1.0.0' },
        loginUrl:      '/login',
        dashboardUrl:  '/users/dashboard.php',
        debug:         true,   // ⚠️ set to false before public launch
    };

    /* ══════════════════════════════════════════════════════════════════
     * STATE
     * ================================================================ */
    let csrfToken   = null;
    let csrfPromise = null;
    let currentUser = null;
    let bootstrapPromise = null;
    let bootstrapped = false;

    /* ══════════════════════════════════════════════════════════════════
     * LOGGING
     * ================================================================ */
    function log(...args) {
        if (CONFIG.debug) console.log('%c[Citadel]', 'color:#00e5ff', ...args);
    }
    function warn(...args) {
        console.warn('%c[Citadel]', 'color:#ffc72c', ...args);
    }

    /* ══════════════════════════════════════════════════════════════════
     * EVENT DISPATCH
     * ================================================================ */
    function emit(name, detail) {
        try {
            window.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
        } catch (_) { /* very old browsers — ignore */ }
    }

    /* ══════════════════════════════════════════════════════════════════
     * CSRF TOKEN
     * ================================================================ */

    async function fetchCsrf() {
        const res = await fetch(CONFIG.apiBase + '/auth/csrf.php', {
            credentials: 'include',
            headers: CONFIG.clientHeader,
        });
        if (!res.ok) {
            throw new Error('Could not fetch CSRF token (HTTP ' + res.status + ')');
        }
        const data = await res.json();
        csrfToken = data.token || null;
        csrfPromise = null;   // release the lock now that we have a fresh token
        log('CSRF token fetched');
        return csrfToken;
    }

    function ensureCsrf() {
        if (csrfToken) return Promise.resolve(csrfToken);
        if (csrfPromise) return csrfPromise;
        csrfPromise = fetchCsrf().catch(err => {
            csrfPromise = null;  // allow retry on next call
            throw err;
        });
        return csrfPromise;
    }

    /* ══════════════════════════════════════════════════════════════════
     * CORE REQUEST
     * ================================================================ */

    async function request(method, path, body = null, options = {}) {
        const url = CONFIG.apiBase + path;
        const methodUpper = method.toUpperCase();
        const isSafe = ['GET', 'HEAD', 'OPTIONS'].includes(methodUpper);

        const headers = Object.assign({}, CONFIG.clientHeader, options.headers || {});

        if (!isSafe) {
            await ensureCsrf();
            if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
        }

        let bodyToSend;
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
            log('Network error on ' + path, err);
            throw new Error('Network error. Check your connection.');
        }

        let data;
        try {
            data = await res.json();
        } catch (err) {
            log('Non-JSON response from ' + path + ' (HTTP ' + res.status + ')');
            throw new Error('Server returned an unexpected response.');
        }

        // Server rotated the CSRF token — cache the new one
        if (data && typeof data.csrf_token === 'string' && data.csrf_token.length > 0) {
            csrfToken = data.csrf_token;
            csrfPromise = null;
            log('CSRF token rotated by server');
        }

        // 401 handling — session expired or never existed
        if (res.status === 401) {
            log('401 on ' + path + ' — clearing session');
            const wasLoggedIn = currentUser !== null;
            currentUser = null;
            if (wasLoggedIn) emit('citadel:logout');
            if (!options.silentAuthRedirect) {
                const onLoginPage = window.location.pathname.replace(/\/$/, '').endsWith(CONFIG.loginUrl);
                if (!onLoginPage) {
                    const returnTo = encodeURIComponent(
                        window.location.pathname + window.location.search
                    );
                    window.location.href = CONFIG.loginUrl + '?next=' + returnTo;
                }
            }
        }

        if (!data || typeof data.status !== 'string') {
            throw new Error('Malformed response from server.');
        }

        if (data.status === 'error') {
            const err = new Error(data.message || 'Request failed.');
            err.code       = data.code || 'unknown';
            err.httpStatus = res.status;
            err.payload    = data;
            throw err;
        }

        return data;
    }

    function get(path, options)        { return request('GET',    path, null, options); }
    function post(path, body, options) { return request('POST',   path, body, options); }
    function put(path, body, options)  { return request('PUT',    path, body, options); }
    function del(path, body, options)  { return request('DELETE', path, body, options); }

    /* ══════════════════════════════════════════════════════════════════
     * SESSION
     * ================================================================ */

    async function fetchCurrentUser() {
        try {
            const data = await get('/users/me.php', { silentAuthRedirect: true });
            const previous = currentUser;
            currentUser = data.user || null;

            // Fire transition events only when the state actually changed
            if (currentUser && !previous) {
                emit('citadel:login', { user: currentUser });
            } else if (!currentUser && previous) {
                emit('citadel:logout');
            }

            return currentUser;
        } catch (err) {
            if (err.httpStatus === 401) {
                currentUser = null;
                return null;
            }
            throw err;
        }
    }

    /* Single, authoritative bootstrap. Parallel CSRF + user fetch.
     * Idempotent — safe to call multiple times. Returns the same promise. */
    function bootstrap() {
        if (bootstrapPromise) return bootstrapPromise;

        bootstrapPromise = (async function run() {
            log('bootstrap starting');

            // Fire them in parallel — /me is a GET so it doesn't need CSRF.
            // Running in parallel halves the wall-clock time vs sequential.
            const [csrfResult, userResult] = await Promise.allSettled([
                ensureCsrf(),
                fetchCurrentUser()
            ]);

            if (csrfResult.status === 'rejected') {
                warn('CSRF bootstrap failed:', csrfResult.reason);
            }
            if (userResult.status === 'rejected') {
                warn('User bootstrap failed:', userResult.reason);
            }

            bootstrapped = true;
            log('bootstrap complete — ' +
                (currentUser ? 'user=' + currentUser.username : 'guest'));

            emit('citadel:ready', { user: currentUser });
            return currentUser;
        })();

        return bootstrapPromise;
    }

    async function requireAuth() {
        const user = await fetchCurrentUser();
        if (!user) {
            const returnTo = encodeURIComponent(
                window.location.pathname + window.location.search
            );
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

    async function logout() {
        // Force a fresh CSRF token — the cached one may be stale, which would
        // cause /auth/logout.php to reject the request and leave the server
        // session alive.
        csrfToken = null;
        csrfPromise = null;
    
        try {
            await ensureCsrf();
        } catch (err) {
            warn('CSRF refresh before logout failed:', err);
        }
    
        try {
            await post('/auth/logout.php', {});
            log('logout API call succeeded');
        } catch (err) {
            warn('logout API call failed (continuing client-side logout):', err);
        }
    
        const wasLoggedIn = currentUser !== null;
        currentUser = null;
        csrfToken = null;
        csrfPromise = null;
        bootstrapPromise = null;
        bootstrapped = false;
    
        if (wasLoggedIn) emit('citadel:logout');
    
        try {
            document.cookie = 'citadel_ui_hint=0; Path=/; Max-Age=0; Secure; SameSite=Lax';
        } catch (_) { /* ignore */ }
    }

    /* ══════════════════════════════════════════════════════════════════
     * PUBLIC API
     * ================================================================ */

    const Citadel = {
        /* Config accessors */
        get apiBase()      { return CONFIG.apiBase; },
        get loginUrl()     { return CONFIG.loginUrl; },
        get dashboardUrl() { return CONFIG.dashboardUrl; },

        /* HTTP verbs */
        get, post, put, del, request,

        /* CSRF */
        getCsrf:     () => csrfToken,
        refreshCsrf: fetchCsrf,

        /* Session */
        bootstrap,
        fetchCurrentUser,
        requireAuth,
        redirectIfAuthed,
        logout,

        /* State accessors */
        get user()        { return currentUser; },
        get isBootstrapped() { return bootstrapped; },
        isLoggedIn:       () => currentUser !== null,

        /* Promise that resolves when bootstrap completes */
        get ready()       { return bootstrapPromise || bootstrap(); },

        /* Debug */
        setDebug: (on) => { CONFIG.debug = !!on; },

        /* DOM helpers (safe, no innerHTML) */
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

    /* ══════════════════════════════════════════════════════════════════
     * EXPORT + AUTO-BOOTSTRAP
     * ================================================================ */

    window.Citadel = Citadel;
    log('citadel-app.js loaded');

    // Kick off bootstrap immediately. Any consumer (nav.js, dashboard.js)
    // can either:
    //   • await window.Citadel.ready
    //   • or listen for 'citadel:ready'
    //
    // Both are guaranteed to receive the same resolved value.
    bootstrap().catch(err => {
        warn('top-level bootstrap threw:', err);
        // Still dispatch so consumers don't hang forever
        emit('citadel:ready', { user: null });
    });

})(window, document);