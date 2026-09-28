/* ============================================================================
 * ███ NAV.JS ███
 * MyCitadel — Nav Hydration
 * ----------------------------------------------------------------------------
 * Reads session state from citadel-app.js (already fetched /me during
 * bootstrap) and swaps the nav between guest, user, and loading states.
 * ========================================================================== */
(function () {
    'use strict';

    /* ── State switcher ──────────────────────────────────────────────── */
    function setAuthState(state) {
        document.querySelectorAll('[data-auth-state]').forEach(function (el) {
            el.hidden = el.dataset.authState !== state;
        });
    }

    /* ── Render the authenticated user ───────────────────────────────── */
    function renderUser(user) {
        const nav = document.getElementById('citadel-nav-auth');
        if (!nav || !user) return;

        const nameEl   = nav.querySelector('[data-username]');
        const avatarEl = nav.querySelector('[data-avatar]');

        if (nameEl) nameEl.textContent = user.username || 'Citizen';

        if (avatarEl) {
            if (user.avatar_url) {
                avatarEl.style.backgroundImage = 'url("' + user.avatar_url + '")';
                avatarEl.textContent = '';
            } else {
                avatarEl.style.backgroundImage = '';
                avatarEl.textContent = (user.username || '?').charAt(0).toUpperCase();
            }
        }

        // Persist a UI hint so the next page load renders the user state instantly
        try {
            document.cookie = 'citadel_ui_hint=1; Path=/; Max-Age=2592000; Secure; SameSite=Lax';
        } catch (e) { /* cookie disabled — harmless */ }
    }

    /* ── Clear the UI hint on logout or session expiry ───────────────── */
    function clearHint() {
        try {
            document.cookie = 'citadel_ui_hint=0; Path=/; Max-Age=0; Secure; SameSite=Lax';
        } catch (e) { /* ignore */ }
    }

    /* ── Notifications badge (optional — polls /notifications/list) ───── */
    async function refreshNotificationBadge() {
        if (!window.Citadel || !window.Citadel.isLoggedIn()) return;
        try {
            const data = await window.Citadel.get('/notifications/list.php?unread_only=1&limit=1');
            const badge = document.querySelector('[data-badge="notifications"]');
            if (!badge) return;
            const count = Number(data.unread_count || 0);
            if (count > 0) {
                badge.textContent = count > 99 ? '99+' : String(count);
                badge.hidden = false;
            } else {
                badge.hidden = true;
            }
        } catch (e) { /* silent — not critical */ }
    }

    /* ── Wire everything up after DOM + Citadel bootstrap ────────────── */
    document.addEventListener('DOMContentLoaded', function () {

        // Start in loading state
        setAuthState('loading');

        // Wait one tick for citadel-app's async bootstrap to finish.
        // It sets window.Citadel.user synchronously on completion, so we
        // just need to give it a chance.
        (async function boot() {
            // Poll for up to ~1.5s while citadel-app runs its bootstrap
            const deadline = Date.now() + 1500;
            while (!window.Citadel && Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 50));
            }
            if (!window.Citadel) { setAuthState('guest'); return; }

            // Give bootstrap a moment to populate the user cache
            while (!window.Citadel.user && Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 50));
            }

            const user = window.Citadel.user;
            if (user) {
                renderUser(user);
                setAuthState('user');
                refreshNotificationBadge();
                // Refresh badge every 60s
                setInterval(refreshNotificationBadge, 60000);
            } else {
                clearHint();
                setAuthState('guest');
            }
        })();

        /* ── Dropdown toggle ────────────────────────────────────────── */
        const toggle = document.getElementById('citadel-nav-user-toggle');
        const dd     = document.getElementById('citadel-nav-dropdown');

        if (toggle && dd) {
            toggle.addEventListener('click', function (e) {
                e.stopPropagation();
                const isOpen = !dd.hidden;
                dd.hidden = isOpen;
                toggle.setAttribute('aria-expanded', String(!isOpen));
            });

            // Close on outside click
            document.addEventListener('click', function (e) {
                if (!dd.hidden && !dd.contains(e.target) && e.target !== toggle) {
                    dd.hidden = true;
                    toggle.setAttribute('aria-expanded', 'false');
                }
            });

            // Close on Escape
            document.addEventListener('keydown', function (e) {
                if (e.key === 'Escape' && !dd.hidden) {
                    dd.hidden = true;
                    toggle.setAttribute('aria-expanded', 'false');
                    toggle.focus();
                }
            });
        }

        /* ── Mobile burger ──────────────────────────────────────────── */
        const burger = document.getElementById('citadel-nav-burger');
        const navEl  = document.getElementById('citadel-nav');
        if (burger && navEl) {
            burger.addEventListener('click', function () {
                const open = navEl.classList.toggle('is-open');
                burger.setAttribute('aria-expanded', String(open));
            });
        }

        /* ── Logout link ────────────────────────────────────────────── */
        document.querySelectorAll('[data-action="logout"]').forEach(function (el) {
            el.addEventListener('click', async function (e) {
                e.preventDefault();
                try {
                    await window.Citadel.post('/auth/logout.php', {});
                } catch (_) { /* logout even if API errors */ }
                clearHint();
                window.location.href = '/';
            });
        });

    });
})();