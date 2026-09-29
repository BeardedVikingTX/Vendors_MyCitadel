/* ============================================================================
 * ███ LOGOUT.JS ███
 * MyCitadel — Terminate the current session and return home.
 * ----------------------------------------------------------------------------
 * Runs automatically on /logout. Behaviour:
 *   1. Best-effort POST to /v1/auth/logout.php (invalidates the API session)
 *   2. Clears the citadel_ui_hint cookie (client-side state)
 *   3. Dispatches 'citadel:logout' so any other listener updates
 *   4. Shows the "Signed Out" confirmation card
 *   5. Redirects to / after ~1.2s
 *
 * If the API call fails (network error, session already gone), we STILL
 * proceed with the client-side cleanup. A user who wants to log out must
 * always be able to.
 * ========================================================================== */

(function () {
    'use strict';

    const root = document.querySelector('.logout-root');
    if (!root) return;

    const API_BASE  = root.dataset.apiBase  || 'https://api.mycitadel.lol/v1';
    const CLIENT    = root.dataset.client   || 'browser/1.0.0';
    const HOME_URL  = root.dataset.homeUrl  || '/';

    const cardEl = document.getElementById('logout-card');
    const doneEl = document.getElementById('logout-done');

    const log  = (...a) => console.log('[logout]', ...a);
    const warn = (...a) => console.warn('[logout]', ...a);

    /* ══════════════════════════════════════════════════════════════
     * CLEANUP — always runs, even if the API call fails
     * ================================================================ */

    function clearClientState() {
        // Clear the UI hint cookie that nav.js uses for instant user render
        try {
            document.cookie = 'citadel_ui_hint=0; Path=/; Max-Age=0; Secure; SameSite=Lax';
        } catch (_) { /* cookie blocked — harmless */ }

        // Fire an event any listener can react to
        try {
            window.dispatchEvent(new CustomEvent('citadel:logout', { detail: {} }));
        } catch (_) { /* very old browsers */ }
    }

    /* ══════════════════════════════════════════════════════════════
     * API CALL — best effort, never blocks the UI
     * ================================================================ */

    async function callLogoutApi() {
        // Try window.Citadel first — it handles CSRF + credentials
        if (window.Citadel && typeof window.Citadel.post === 'function') {
            try {
                await window.Citadel.post('/auth/logout.php', {});
                log('logout via window.Citadel');
                return true;
            } catch (e) {
                warn('window.Citadel.logout failed, falling back:', e && e.message);
            }
        }

        // Fallback: manual call with CSRF fetch
        try {
            const csrfRes = await fetch(API_BASE + '/auth/csrf.php', {
                credentials: 'include',
                headers: { 'X-Citadel-Client': CLIENT },
            });
            const csrfData = await csrfRes.json();
            const token = csrfData && csrfData.token ? csrfData.token : '';

            await fetch(API_BASE + '/auth/logout.php', {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': token,
                    'X-Citadel-Client': CLIENT,
                },
                body: '{}',
            });
            log('logout via manual fetch');
            return true;
        } catch (e) {
            warn('manual logout fetch failed:', e && e.message);
            return false;
        }
    }

    /* ══════════════════════════════════════════════════════════════
     * UI STATE
     * ================================================================ */

    function showDone() {
        if (cardEl) cardEl.hidden = true;
        if (doneEl) doneEl.hidden = false;
    }

    /* ══════════════════════════════════════════════════════════════
     * BOOT
     * ================================================================ */

    async function run() {
        log('starting logout flow');

        // Wait for citadel-app.js to be ready if it's still bootstrapping.
        // We give it up to 2 seconds, then proceed regardless.
        if (!window.Citadel) {
            await new Promise((resolve) => {
                let settled = false;
                const onReady = () => {
                    if (settled) return;
                    settled = true;
                    window.removeEventListener('citadel:ready', onReady);
                    resolve();
                };
                window.addEventListener('citadel:ready', onReady, { once: true });
                setTimeout(() => {
                    if (settled) return;
                    settled = true;
                    window.removeEventListener('citadel:ready', onReady);
                    resolve();
                }, 2000);
            });
        }

        // Fire the API call and the client cleanup in parallel
        await callLogoutApi();
        clearClientState();

        log('session terminated');
        showDone();

        // Give the user a beat to see the confirmation, then redirect
        setTimeout(() => {
            window.location.href = HOME_URL;
        }, 1200);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', run);
    } else {
        run();
    }

})();