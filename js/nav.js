/* ============================================================================
 * ███ NAV.JS ███
 * MyCitadel — Nav Hydration
 * ----------------------------------------------------------------------------
 * Watches citadel-app.js for session state and swaps the nav between
 * guest / user / loading states. Also handles the user dropdown, mobile
 * burger menu, and logout.
 *
 * HOW IT WORKS
 *   1. On DOMContentLoaded, check if window.Citadel.user is already set.
 *      If yes, apply immediately.
 *   2. Otherwise, listen for the 'citadel:ready' event dispatched by
 *      citadel-app.js after bootstrap completes.
 *   3. If neither happens within 5s, fall back to guest state (safety net
 *      for when citadel-app.js fails to load).
 *
 * NO POLLING. NO ARBITRARY TIMEOUTS. Event-driven only.
 * ========================================================================== */
(function () {
    'use strict';

    const LOG = '[nav]';
    const SAFETY_TIMEOUT_MS = 5000;

    let stateApplied = false;

    /* ── Logging ─────────────────────────────────────────────────────── */
    function log(...args)  { console.log(LOG, ...args); }
    function warn(...args) { console.warn(LOG, ...args); }

    /* ── State switcher ──────────────────────────────────────────────── */
    function setAuthState(state) {
        document.querySelectorAll('[data-auth-state]').forEach(function (el) {
            el.hidden = el.dataset.authState !== state;
        });
        log('state →', state);
    }

    /* ── Render the authenticated user ───────────────────────────────── */
    function renderUser(user) {
        const nav = document.getElementById('citadel-nav-auth');
        if (!nav || !user) return;

        const nameEl   = nav.querySelector('[data-username]');
        const avatarEl = nav.querySelector('[data-avatar]');

        if (nameEl) {
            nameEl.textContent = user.username || 'Citizen';
        }

        if (avatarEl) {
            if (user.avatar_url) {
                avatarEl.style.backgroundImage = 'url("' + user.avatar_url + '")';
                avatarEl.textContent = '';
            } else {
                avatarEl.style.backgroundImage = '';
                avatarEl.textContent = (user.username || '?').charAt(0).toUpperCase();
            }
        }

        // Persist a UI hint so the next page load can render the user state
        // instantly (without waiting for the API round-trip).
        try {
            document.cookie = 'citadel_ui_hint=1; Path=/; Max-Age=2592000; Secure; SameSite=Lax';
        } catch (e) { /* cookie disabled — harmless */ }
    }

    /* ── Clear the UI hint on logout ─────────────────────────────────── */
    function clearHint() {
        try {
            document.cookie = 'citadel_ui_hint=0; Path=/; Max-Age=0; Secure; SameSite=Lax';
        } catch (e) { /* ignore */ }
    }

    /* ── Notifications badge (optional — polls /notifications/list) ──── */
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
        } catch (e) {
            // Silent — notifications are non-critical. Common failure:
            // the endpoint doesn't exist yet in this build. That's fine.
        }
    }

    /* ── Apply the resolved auth state (idempotent) ──────────────────── */
    function applyUserState(user) {
        if (stateApplied) return;
        stateApplied = true;

        if (user) {
            log('applying user state for', user.username);
            renderUser(user);
            setAuthState('user');
            refreshNotificationBadge();
            refreshMessagesBadge();
            setInterval(refreshMessagesBadge, 60000);
        } else {
            log('applying guest state');
            clearHint();
            setAuthState('guest');
        }
    }

    async function refreshMessagesBadge() {
        if (!window.Citadel || !window.Citadel.isLoggedIn()) return;
        try {
            const data = await window.Citadel.get('/messages/conversations.php');
            const list = data.conversations || [];
            const total = list.reduce((sum, c) => sum + (Number(c.unread_count) || 0), 0);
    
            const badge = document.querySelector('[data-badge="messages"]');
            if (!badge) return;
            if (total > 0) {
                badge.textContent = total > 99 ? '99+' : String(total);
                badge.hidden = false;
            } else {
                badge.hidden = true;
            }
        } catch (_) { /* silent — non-critical */ }
    }    

    /* ── Wire up DOM-interactive elements (dropdown, burger, logout) ─── */
    function wireInteractions() {
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

        /* ── Logout link(s) ─────────────────────────────────────────── */
        document.querySelectorAll('[data-action="logout"]').forEach(function (el) {
            el.addEventListener('click', async function (e) {
                e.preventDefault();
        
                // Preferred: use the client's own logout method — it clears
                // in-memory state, dispatches 'citadel:logout', and clears the
                // UI hint cookie.
                try {
                    if (window.Citadel && typeof window.Citadel.logout === 'function') {
                        await window.Citadel.logout();
                    } else if (window.Citadel && typeof window.Citadel.post === 'function') {
                        await window.Citadel.post('/auth/logout.php', {});
                    }
                } catch (err) {
                    warn('logout API call failed (continuing anyway):', err);
                }
        
                clearHint();
                window.location.href = '/';
            });
        });
    }

    /* ── Main boot ───────────────────────────────────────────────────── */
    function boot() {
        log('boot — checking session state');

        // Start in loading state
        setAuthState('loading');

        // Wire up DOM interactions immediately (dropdown toggle, burger,
        // logout link) — they don't depend on auth state.
        wireInteractions();

        // ── Path 1: user is already known (bootstrap beat us here) ────
        if (window.Citadel && window.Citadel.user) {
            log('user already set — applying immediately');
            applyUserState(window.Citadel.user);
            return;
        }

        // ── Path 2: wait for citadel-app.js to fire 'citadel:ready' ───
        let resolved = false;

        const onReady = function (e) {
            if (resolved) return;
            resolved = true;
            const user = (e && e.detail && e.detail.user) || null;
            log('received citadel:ready —', user ? ('user=' + user.username) : 'guest');
            applyUserState(user);
        };

        window.addEventListener('citadel:ready', onReady, { once: true });

        // ── Path 3: safety net — if nothing happens in 5s, give up ────
        // This only fires if citadel-app.js is missing, broken, or blocked
        // by a CSP. The user gets guest state, which is always safe.
        setTimeout(function () {
            if (resolved) return;
            resolved = true;
            window.removeEventListener('citadel:ready', onReady);
            warn('safety timeout fired — citadel-app.js may have failed. Defaulting to guest.');
            // Double-check once more in case the user was set silently
            if (window.Citadel && window.Citadel.user) {
                applyUserState(window.Citadel.user);
            } else {
                applyUserState(null);
            }
        }, SAFETY_TIMEOUT_MS);
    }

    /* ── Entry point ─────────────────────────────────────────────────── */
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        // DOM already parsed (script loaded late) — boot immediately
        boot();
    }

})();