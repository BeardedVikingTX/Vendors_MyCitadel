/* ============================================================================
 * ███ COOKIES.JS ███
 * MyCitadel — Essential Client-Side Session & Preference Helpers
 * ----------------------------------------------------------------------------
 * Subdomain : https://vendors.mycitadel.lol/js/cookies.js
 * Author    : Bearded Viking (https://beardedviking.org)
 * Project   : MyCitadel (https://mycitadel.lol)
 * License   : MIT
 *
 * PURPOSE
 *   This file handles three narrow, essential tasks:
 *
 *   1. CSRF TOKENS
 *      Reads the CSRF token cookie set by the server and exposes it so
 *      forms and fetch() calls can send it back in a header. Implements
 *      the industry-standard "double-submit cookie" pattern.
 *
 *   2. UI PREFERENCES
 *      Stores non-sensitive user interface choices (theme, sidebar state,
 *      font size preference) so the UI doesn't flash on every page load.
 *
 *   3. SESSION STATE HINT
 *      A PUBLIC, NON-SECRET flag (not the auth session!) that tells the
 *      UI whether the user appears to be logged in. Used only to decide
 *      which buttons to render. The actual authority is always the API.
 *
 * WHAT THIS FILE EXPLICITLY DOES NOT DO
 *   ✗ No analytics
 *   ✗ No tracking pixels or beacons
 *   ✗ No fingerprinting (canvas, WebGL, fonts, audio)
 *   ✗ No referrer capture
 *   ✗ No page-view logging
 *   ✗ No cross-site cookies
 *   ✗ No third-party calls
 *   ✗ No PII storage (no emails, no names, no user IDs)
 *   ✗ NO ACCESS TO THE AUTH SESSION COOKIE
 *
 * THE AUTH SESSION COOKIE IS SACRED
 *   The cookie that keeps a user logged in is named `citadel_sid` and is
 *   set by PHP with the `HttpOnly` flag. That means JavaScript literally
 *   CANNOT read it — not this file, not any file, not an attacker's
 *   injected script. This is a browser-enforced guarantee. Do not try to
 *   work around it. Do not store session tokens in localStorage. The
 *   server is the only authority on who is logged in.
 *
 * USAGE
 *   <script src="https://vendors.mycitadel.lol/js/cookies.js" defer></script>
 *   <script>
 *     // Send a POST with the CSRF token automatically attached:
 *     Citadel.fetch('/api/v1/auth/login', { method: 'POST', body: data });
 *
 *     // Read a preference:
 *     const theme = Citadel.prefs.get('theme', 'dark');
 *
 *     // Save a preference:
 *     Citadel.prefs.set('theme', 'light');
 *
 *     // Ask if the UI should render as logged-in:
 *     if (Citadel.session.looksLoggedIn()) { ... }
 *   </script>
 * ========================================================================== */

(function (window, document) {
    'use strict';

    /* ══════════════════════════════════════════════════════════════════════
     * CONFIGURATION
     * ════════════════════════════════════════════════════════════════════ */

    const CONFIG = {
        // Names of cookies and storage keys we use.
        csrfCookie:    'citadel_csrf',      // readable by JS, set by server
        csrfHeader:    'X-CSRF-Token',      // header name for outgoing requests
        sessionHint:   'citadel_authed',    // public flag: "1" or "0"
        prefsPrefix:   'citadel_pref_',     // localStorage prefix for UI prefs

        // Domains that count as "us" for fetch() helper.
        allowedHosts:  ['mycitadel.lol', 'api.mycitadel.lol'],

        // Debug logging. MUST be false in production.
        debug: false
    };


    /* ══════════════════════════════════════════════════════════════════════
     * LOGGING
     * ════════════════════════════════════════════════════════════════════ */

    const log = (...args) => {
        if (CONFIG.debug) console.log('%c[Citadel]', 'color:#00e5ff', ...args);
    };


    /* ══════════════════════════════════════════════════════════════════════
     * COOKIE PRIMITIVES
     * ----------------------------------------------------------------------
     * Minimal, safe read/write/delete for the handful of NON-SECRET cookies
     * this file is allowed to touch. Never used for the auth session.
     * ════════════════════════════════════════════════════════════════════ */

    /**
     * Read a cookie by name.
     * @param {string} name
     * @returns {string|null}
     */
    function getCookie(name) {
        const match = document.cookie.match(
            new RegExp('(?:^|; )' + name.replace(/([.$?*|{}()[\]\\/+^])/g, '\\$1') + '=([^;]*)')
        );
        return match ? decodeURIComponent(match[1]) : null;
    }

    /**
     * Write a cookie with secure defaults.
     * SameSite=Strict prevents CSRF and cross-site leaks.
     * Secure ensures HTTPS-only.
     * We DO NOT set HttpOnly here — because these are non-secret values
     * that JS is legitimately allowed to read. Anything that needs
     * HttpOnly is set by the server, not by this file.
     *
     * @param {string} name
     * @param {string} value
     * @param {number} maxAgeSeconds
     */
    function setCookie(name, value, maxAgeSeconds) {
        document.cookie = [
            `${name}=${encodeURIComponent(value)}`,
            'Path=/',
            'SameSite=Strict',
            'Secure',
            `Max-Age=${maxAgeSeconds}`
        ].join('; ');
    }

    /**
     * Delete a cookie.
     * @param {string} name
     */
    function deleteCookie(name) {
        document.cookie = `${name}=; Path=/; SameSite=Strict; Secure; Max-Age=0`;
    }


    /* ══════════════════════════════════════════════════════════════════════
     * LOCALSTORAGE HELPERS
     * ----------------------------------------------------------------------
     * Safe JSON read/write with fallbacks. localStorage can throw (private
     * mode, quota exceeded, disabled) — we degrade gracefully.
     * ════════════════════════════════════════════════════════════════════ */

    function lsGet(key, fallback = null) {
        try {
            const raw = localStorage.getItem(key);
            return raw === null ? fallback : JSON.parse(raw);
        } catch {
            return fallback;
        }
    }

    function lsSet(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (e) {
            log('localStorage write failed', e);
            return false;
        }
    }

    function lsDelete(key) {
        try { localStorage.removeItem(key); }
        catch { /* ignore */ }
    }


    /* ══════════════════════════════════════════════════════════════════════
     * CSRF — DOUBLE-SUBMIT COOKIE PATTERN
     * ----------------------------------------------------------------------
     * How it works:
     *   1. The server sets a cookie `citadel_csrf` with a random token.
     *      This cookie is NOT HttpOnly — JS needs to read it.
     *   2. When the client makes a state-changing request (POST/PUT/DELETE),
     *      it sends the same token in an `X-CSRF-Token` header.
     *   3. The server compares the header to the cookie. If they match,
     *      the request is legitimate. If not, it's a forged request from
     *      another origin (a CSRF attack) and is rejected.
     *
     * This works because an attacker on evil.com cannot:
     *   • Read the victim's cookies (same-origin policy blocks it)
     *   • Set custom headers on cross-origin requests without CORS approval
     *
     * The cookie is paired with the auth session cookie (HttpOnly, server-set)
     * to provide complete request authenticity.
     * ════════════════════════════════════════════════════════════════════ */

    const csrf = {
        /** Read the current CSRF token from its cookie. */
        token() {
            return getCookie(CONFIG.csrfCookie);
        },

        /** True if a CSRF token is currently present. */
        has() {
            return this.token() !== null;
        },

        /**
         * Ensure a CSRF token exists. If not, request one from the API.
         * Call this once on page load before any form is submitted.
         * @returns {Promise<string|null>}
         */
        async ensure() {
            if (this.has()) return this.token();
            try {
                const res = await fetch('https://api.mycitadel.lol/v1/auth/csrf', {
                    method: 'GET',
                    credentials: 'include'
                });
                if (!res.ok) return null;
                // The server's response is expected to set the citadel_csrf cookie.
                // Give the browser a moment to process it.
                return getCookie(CONFIG.csrfCookie);
            } catch (e) {
                log('CSRF fetch failed', e);
                return null;
            }
        },

        /**
         * Attach the CSRF token to an outgoing fetch() options object.
         * Internal helper — you normally don't call this directly.
         * @param {object} options
         */
        attach(options = {}) {
            const t = this.token();
            if (!t) return options;
            options.headers = Object.assign({}, options.headers, {
                [CONFIG.csrfHeader]: t
            });
            return options;
        }
    };


    /* ══════════════════════════════════════════════════════════════════════
     * FETCH WRAPPER
     * ----------------------------------------------------------------------
     * A thin wrapper around window.fetch() that:
     *   • Automatically attaches the CSRF token on unsafe methods
     *   • Always includes credentials (needed for the auth session cookie)
     *   • Only allows requests to MyCitadel-owned hosts
     *   • Never leaks cookies to external origins
     * ════════════════════════════════════════════════════════════════════ */

    const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

    /**
     * @param {string} url
     * @param {object} [options]
     * @returns {Promise<Response>}
     */
    async function citadelFetch(url, options = {}) {
        // Resolve relative URLs against the current origin.
        const fullUrl = new URL(url, window.location.origin);
        const method = (options.method || 'GET').toUpperCase();

        // Refuse to send credentials to hosts we don't own.
        const isOurs = CONFIG.allowedHosts.some(h =>
            fullUrl.hostname === h || fullUrl.hostname.endsWith('.' + h)
        );
        if (!isOurs) {
            throw new Error(`Citadel.fetch: refusing to send to external host "${fullUrl.hostname}"`);
        }

        // Same-origin includes credentials (cookies) by default.
        const finalOptions = Object.assign({
            credentials: 'include',
            mode: 'cors'
        }, options);

        // Attach CSRF on unsafe methods.
        if (!SAFE_METHODS.includes(method)) {
            csrf.attach(finalOptions);
        }

        // Default JSON content type if body is a plain object.
        if (finalOptions.body && typeof finalOptions.body === 'object'
            && !(finalOptions.body instanceof FormData)
            && !(finalOptions.body instanceof Blob)) {
            finalOptions.headers = Object.assign(
                { 'Content-Type': 'application/json' },
                finalOptions.headers
            );
            finalOptions.body = JSON.stringify(finalOptions.body);
        }

        return window.fetch(fullUrl.toString(), finalOptions);
    }


    /* ══════════════════════════════════════════════════════════════════════
     * UI PREFERENCES
     * ----------------------------------------------------------------------
     * Non-sensitive, user-controlled, non-identifying. Stored in localStorage
     * so we don't need a cookie for each one. These are UX niceties, not
     * tracking.
     * ════════════════════════════════════════════════════════════════════ */

    const prefs = {
        /**
         * Get a preference value.
         * @param {string} key
         * @param {*} [fallback]
         */
        get(key, fallback = null) {
            return lsGet(CONFIG.prefsPrefix + key, fallback);
        },

        /**
         * Set a preference value.
         * @param {string} key
         * @param {*} value
         */
        set(key, value) {
            return lsSet(CONFIG.prefsPrefix + key, value);
        },

        /**
         * Remove a preference (reverts to default).
         * @param {string} key
         */
        remove(key) {
            lsDelete(CONFIG.prefsPrefix + key);
        },

        /**
         * Wipe ALL Citadel preferences. Called from the "Reset UI" button.
         */
        clearAll() {
            try {
                Object.keys(localStorage)
                    .filter(k => k.startsWith(CONFIG.prefsPrefix))
                    .forEach(k => localStorage.removeItem(k));
            } catch { /* ignore */ }
        }
    };


    /* ══════════════════════════════════════════════════════════════════════
     * SESSION STATE HINT
     * ----------------------------------------------------------------------
     * A PUBLIC, NON-SECRET flag that tells the UI "assume the user is logged
     * in" so it can render the right buttons without a full API round-trip
     * on every page load.
     *
     * IMPORTANT: This is a HINT, not authority.
     *   • The server is always the source of truth.
     *   • If a user tampers with this flag (it's client-readable), the worst
     *     they do is see a wrong button for a split second — then the API
     *     rejects their request and the UI corrects itself.
     *   • No session tokens, no user IDs, no PII. Just a boolean hint.
     * ════════════════════════════════════════════════════════════════════ */

    const session = {
        /** True if the UI should render as logged-in. */
        looksLoggedIn() {
            return getCookie(CONFIG.sessionHint) === '1';
        },

        /**
         * Called by your login success handler.
         * The server will have already set the real session cookie (HttpOnly).
         * This just sets the public hint so the UI updates immediately.
         */
        markLoggedIn() {
            setCookie(CONFIG.sessionHint, '1', 60 * 60 * 24 * 7); // 7 days
            log('session hint: logged in');
        },

        /**
         * Called by your logout handler.
         * Clears the hint. The server clears the real cookie.
         */
        markLoggedOut() {
            deleteCookie(CONFIG.sessionHint);
            // Also drop any UI prefs that were only meaningful for a logged-in user.
            // (Example: expanded sidebar layout for the dashboard.)
            prefs.remove('dashboard_layout');
            log('session hint: logged out');
        },

        /**
         * If a request to a protected endpoint returns 401/403, call this to
         * force the UI back into logged-out state.
         */
        invalidate() {
            this.markLoggedOut();
            window.dispatchEvent(new CustomEvent('citadel:session-expired'));
        }
    };


    /* ══════════════════════════════════════════════════════════════════════
     * INTERCEPT 401/403 RESPONSES
     * ----------------------------------------------------------------------
     * If any API call returns "unauthenticated", automatically flip the UI
     * back to logged-out state. This keeps the UI in sync with the server
     * without requiring every call site to handle it.
     * ════════════════════════════════════════════════════════════════════ */

    async function citadelFetchWithAuth(url, options = {}) {
        const res = await citadelFetch(url, options);
        if (res.status === 401 || res.status === 403) {
            session.invalidate();
        }
        return res;
    }


    /* ══════════════════════════════════════════════════════════════════════
     * PUBLIC API
     * ════════════════════════════════════════════════════════════════════ */

    const Citadel = {
        csrf,
        prefs,
        session,

        /** fetch() with CSRF + credentials handling */
        fetch: citadelFetch,

        /** fetch() that also invalidates session on 401/403 */
        fetchAuth: citadelFetchWithAuth,

        /** Read a non-secret cookie (for debugging only — never for auth) */
        _getCookie: getCookie
    };


    /* ══════════════════════════════════════════════════════════════════════
     * BOOT
     * ════════════════════════════════════════════════════════════════════ */

    function boot() {
        // Ensure we have a CSRF token ready before any form is submitted.
        // Fire-and-forget — the fetch wrapper attaches it lazily anyway.
        if (!csrf.has()) {
            csrf.ensure().catch(() => { /* silent — will retry on demand */ });
        }

        log('ready', {
            csrf: csrf.has(),
            authed: session.looksLoggedIn()
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

    // Expose globally.
    window.Citadel = Citadel;

})(window, document);

/* ============================================================================
 * ▓▓▓ END OF COOKIES.JS ▓▓▓
 * ----------------------------------------------------------------------------
 * Three things. That's all this file does. If you ever find yourself
 * wanting to add a fourth — stop. Ask whether it belongs on the server.
 * The answer is almost always yes.
 * — Bearded Viking
 * ========================================================================== */