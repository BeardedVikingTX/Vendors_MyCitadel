/* ============================================================================
 * ███ PREMIUM-SUCCESS.JS ███
 * MyCitadel — /premium/success polling
 * ========================================================================== */
(function () {
    'use strict';

    var root = document.querySelector('.premium-success');
    if (!root) return;

    var API = root.dataset.apiBase;
    var CLIENT = root.dataset.client;
    var MAX_TRIES = 8;
    var INTERVAL_MS = 1500;
    var attempt = 0;

    var states = {
        loading:    root.querySelector('[data-state="loading"]'),
        ready:      root.querySelector('[data-state="ready"]'),
        activating: root.querySelector('[data-state="activating"]'),
        guest:      root.querySelector('[data-state="guest"]'),
        error:      root.querySelector('[data-state="error"]')
    };

    function show(name) {
        Object.keys(states).forEach(function (k) {
            if (states[k]) states[k].hidden = (k !== name);
        });
    }

    async function checkStatus() {
        var r = await fetch(API + '/premium/status.php', {
            credentials: 'include',
            headers: { 'X-Citadel-Client': CLIENT }
        });
        if (r.status === 401) return { unauthenticated: true };
        if (!r.ok) throw new Error('status_' + r.status);
        var d = await r.json();
        return d.premium || {};
    }

    async function poll() {
        attempt++;
        try {
            var status = await checkStatus();
            if (status.unauthenticated) { show('guest'); return; }
            if (status.is_premium === true) { show('ready'); return; }
            if (attempt < MAX_TRIES) { setTimeout(poll, INTERVAL_MS); }
            else { show('activating'); }
        } catch (err) {
            if (attempt < MAX_TRIES) { setTimeout(poll, INTERVAL_MS); }
            else { show('error'); }
        }
    }

    var recheckBtn = root.querySelector('[data-recheck]');
    if (recheckBtn) {
        recheckBtn.addEventListener('click', function () {
            attempt = 0;
            show('loading');
            poll();
        });
    }

    poll();
})();