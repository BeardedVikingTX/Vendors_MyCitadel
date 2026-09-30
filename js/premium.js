/* ============================================================================
 * ███ PREMIUM.JS ███
 * MyCitadel — /premium upgrade page CTA state machine
 * ========================================================================== */
(function () {
    'use strict';

    var TAG = '[premium.js]';
    console.log(TAG, 'loaded');

    var root = document.querySelector('.premium-cta');
    if (!root) return;

    var API    = root.dataset.apiBase;
    var CLIENT = root.dataset.client;

    var states = {
        loading:   root.querySelector('[data-state="loading"]'),
        guest:     root.querySelector('[data-state="guest"]'),
        subscribe: root.querySelector('[data-state="subscribe"]'),
        manage:    root.querySelector('[data-state="manage"]'),
        error:     root.querySelector('[data-state="error"]')
    };

    var done = false;

    function show(name) {
        Object.keys(states).forEach(function (k) {
            if (states[k]) states[k].hidden = (k !== name);
        });
    }

    function showError(msg) {
        done = true;
        var el = root.querySelector('[data-error-msg]');
        if (el) el.textContent = msg || 'Something went wrong.';
        show('error');
    }

    // ── CSRF: reuse any global token first, only fetch if none exists ──
    function getCsrf() {
        // 1. Already cached on window by us or another script
        if (window.__citadelCsrf) return Promise.resolve(window.__citadelCsrf);

        // 2. Exposed by citadel-app.js under a conventional name
        if (window.Citadel) {
            if (typeof window.Citadel.csrfToken === 'string' && window.Citadel.csrfToken) {
                window.__citadelCsrf = window.Citadel.csrfToken;
                return Promise.resolve(window.__citadelCsrf);
            }
            if (typeof window.Citadel.getCsrf === 'function') {
                var t = window.Citadel.getCsrf();
                if (t) {
                    window.__citadelCsrf = t;
                    return Promise.resolve(t);
                }
            }
        }

        // 3. Fetch a fresh token — ONLY if nobody else already did
        return fetch(API + '/auth/csrf.php', {
            credentials: 'include',
            headers: { 'X-Citadel-Client': CLIENT }
        })
        .then(function (r) { return r.json(); })
        .then(function (d) {
            if (!d.token) throw new Error('Could not get a session token.');
            window.__citadelCsrf = d.token;
            return d.token;
        });
    }

    // ── POST helper — retries ONCE on csrf_invalid ────────────────────
    async function postJson(url) {
        var token = await getCsrf();

        var r = await fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json',
                'X-Citadel-Client': CLIENT,
                'X-CSRF-Token': token
            },
            body: '{}'
        });
        var d = await r.json().catch(function () { return {}; });

        // Another script rotated the token between our fetch and our POST.
        // Fetch a fresh one and retry — exactly once.
        if (r.status === 403 && d.code === 'csrf_invalid') {
            console.warn(TAG, 'csrf_invalid — refetching token and retrying once');
            window.__citadelCsrf = null;
            token = await getCsrf();
            r = await fetch(url, {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Citadel-Client': CLIENT,
                    'X-CSRF-Token': token
                },
                body: '{}'
            });
            d = await r.json().catch(function () { return {}; });
        }

        return { ok: r.ok, status: r.status, data: d };
    }

    async function fetchMe() {
        var r = await fetch(API + '/users/me.php', {
            credentials: 'include',
            headers: { 'X-Citadel-Client': CLIENT }
        });
        if (r.status === 401) return null;
        if (!r.ok) throw new Error('Server returned ' + r.status + ' for /me');
        var d = await r.json();
        return d.user || null;
    }

    async function init() {
        done = false;
        show('loading');
        try {
            var user = await fetchMe();
            if (!user)        { done = true; show('guest');     return; }
            if (user.premium) { done = true; show('manage');    return; }
            done = true;
            show('subscribe');
        } catch (err) {
            console.error(TAG, 'init failed:', err);
            showError(err.message || 'Could not reach the server.');
        }
    }

    // Watchdog — no infinite spinner
    setTimeout(function () {
        if (!done && states.loading && !states.loading.hidden) {
            console.error(TAG, 'watchdog fired');
            showError('The server took too long to respond. Check the DevTools console for details.');
        }
    }, 10000);

    var subBtn = root.querySelector('.premium-subscribe-btn');
    if (subBtn) {
        subBtn.addEventListener('click', async function () {
            var original = subBtn.textContent;
            subBtn.disabled = true;
            subBtn.textContent = 'Starting checkout…';
            try {
                var res = await postJson(API + '/premium/checkout.php');
                if (res.status === 401) { show('guest'); throw new Error('__handled__'); }
                if (res.status === 409 && res.data.code === 'already_premium') {
                    await init(); throw new Error('__handled__');
                }
                if (!res.ok || !res.data.checkout_url) {
                    throw new Error(res.data.message || 'Could not start checkout.');
                }
                window.location.href = res.data.checkout_url;
            } catch (err) {
                subBtn.disabled = false;
                subBtn.textContent = original;
                if (err.message !== '__handled__') showError(err.message);
            }
        });
    }

    var manageBtn = root.querySelector('.premium-manage-btn');
    if (manageBtn) {
        manageBtn.addEventListener('click', async function () {
            var original = manageBtn.textContent;
            manageBtn.disabled = true;
            manageBtn.textContent = 'Opening billing portal…';
            try {
                var res = await postJson(API + '/premium/portal.php');
                if (!res.ok || !res.data.portal_url) {
                    throw new Error(res.data.message || 'Could not open the billing portal.');
                }
                window.location.href = res.data.portal_url;
            } catch (err) {
                manageBtn.disabled = false;
                manageBtn.textContent = original;
                showError(err.message);
            }
        });
    }

    var retryBtn = root.querySelector('[data-retry]');
    if (retryBtn) retryBtn.addEventListener('click', init);

    init();
})();