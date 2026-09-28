/* ============================================================================
 * ███ LOGIN.JS ███
 * MyCitadel — Login flow with optional 2FA second step.
 * ----------------------------------------------------------------------------
 * Loaded externally so it satisfies the page CSP (script-src 'self').
 * Reads config from data-* attributes on the forms.
 * ========================================================================== */

(function () {
    'use strict';

    const pwForm     = document.getElementById('login-form');
    const twoFaForm  = document.getElementById('login-2fa-form');
    if (!pwForm || !twoFaForm) return;

    const statusEl   = document.getElementById('login-status');
    const API_BASE   = pwForm.dataset.apiBase;
    const CLIENT     = pwForm.dataset.client   || 'browser/1.0.0';
    const REDIRECT   = pwForm.dataset.redirect || '/users/dashboard.php';

    let csrfToken = null;
    let submitting = false;

    /* ── Status helpers ──────────────────────────────────────────── */
    function showStatus(message, kind) {
        if (!statusEl) return;
        statusEl.textContent = message;
        statusEl.className = 'auth-status auth-status--' + (kind || 'info');
        statusEl.style.display = 'block';
    }
    function clearStatus() {
        if (!statusEl) return;
        statusEl.style.display = 'none';
        statusEl.textContent = '';
    }

    /* ── CSRF mint ───────────────────────────────────────────────── */
    async function fetchCsrf() {
        try {
            const res = await fetch(API_BASE + '/auth/csrf.php', {
                method: 'GET',
                credentials: 'include',
                headers: { 'X-Citadel-Client': CLIENT }
            });
            if (!res.ok) throw new Error('CSRF endpoint returned ' + res.status);
            const data = await res.json();
            if (data.status !== 'ok' || !data.token) {
                throw new Error('Malformed CSRF response');
            }
            csrfToken = data.token;
            console.info('[login] CSRF token minted');
        } catch (err) {
            console.error('[login] CSRF fetch failed:', err);
            showStatus(
                'Could not reach the API. Check your connection and reload the page.',
                'error'
            );
        }
    }

    /* ── Redirect if already authenticated ───────────────────────── */
    async function redirectIfLoggedIn() {
        try {
            const res = await fetch(API_BASE + '/users/me.php', {
                method: 'GET',
                credentials: 'include',
                headers: { 'X-Citadel-Client': CLIENT }
            });
            if (res.status === 200) {
                console.info('[login] Already authenticated — redirecting');
                window.location.href = REDIRECT;
            }
        } catch (_) {
            // Ignore — an unauthenticated state is what we want
        }
    }

    /* ── Show / hide the two steps ───────────────────────────────── */
    function show2FA() {
        pwForm.style.display = 'none';
        twoFaForm.style.display = 'block';
        const code = document.getElementById('code');
        if (code) { code.value = ''; code.focus(); }
    }
    function showPasswordStep() {
        twoFaForm.style.display = 'none';
        pwForm.style.display = 'block';
        clearStatus();
    }

    const backLink = document.getElementById('login-2fa-back');
    if (backLink) {
        backLink.addEventListener('click', function (e) {
            e.preventDefault();
            showPasswordStep();
        });
    }

    /* ── Generic error mapping ───────────────────────────────────── */
    function friendlyMessage(code, fallback) {
        const map = {
            missing_credentials: 'Please enter your username or email, and password.',
            invalid_credentials: 'Invalid credentials. Please check and try again.',
            rate_limited:        'Too many attempts. Please wait a few minutes and try again.',
            csrf_invalid:        'Your session expired. Reload the page and try again.',
            origin_required:     'Request blocked by the API gate. Reload the page and try again.',
            invalid_code:        fallback || 'That code did not match. Please try again.',
            no_pending:          'Your 2FA session expired. Please log in again.',
            expired:             'Your 2FA session expired. Please log in again.',
            too_many_attempts:   'Too many wrong codes. Please log in again.',
            account_missing:     'That account no longer exists.'
        };
        return map[code] || fallback || 'Something went wrong. Please try again.';
    }

    /* ── STEP 1: submit identifier + password ────────────────────── */
    pwForm.addEventListener('submit', async function (e) {
        e.preventDefault();
        if (submitting) return;
        clearStatus();

        const identifier = document.getElementById('identifier').value.trim();
        const password   = document.getElementById('password').value;

        if (!identifier) {
            return showStatus('Please enter your username or email.', 'error');
        }
        if (!password) {
            return showStatus('Please enter your password.', 'error');
        }

        if (!csrfToken) {
            await fetchCsrf();
            if (!csrfToken) return;
        }

        submitting = true;
        const btn = document.getElementById('login-btn');
        btn.disabled = true;
        btn.textContent = 'Signing in…';

        try {
            const res = await fetch(API_BASE + '/auth/login.php', {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type':    'application/json',
                    'X-CSRF-Token':    csrfToken,
                    'X-Citadel-Client': CLIENT
                },
                body: JSON.stringify({ identifier, password })
            });

            let data;
            try { data = await res.json(); }
            catch (_) { data = null; }

            /* ── 2FA required ─────────────────────────────────────── */
            if (res.status === 200 && data && data.status === 'ok' && data.two_fa_required) {
                // Refresh CSRF state if the API rotated it
                if (data.csrf_token) csrfToken = data.csrf_token;
                console.info('[login] 2FA required');
                show2FA();
                showStatus(data.message || 'Enter your 2FA code.', 'info');
                return;
            }

            /* ── Success ──────────────────────────────────────────── */
            if (res.status === 200 && data && data.status === 'ok' && data.user) {
                if (data.csrf_token) csrfToken = data.csrf_token;
                showStatus('Welcome back, ' + data.user.username + '. Redirecting…', 'success');
                setTimeout(function () {
                    window.location.href = REDIRECT;
                }, 700);
                return;
            }

            /* ── Failure ──────────────────────────────────────────── */
            const code    = data && data.code    ? data.code    : 'unknown_error';
            const message = data && data.message ? data.message : null;
            showStatus(friendlyMessage(code, message), 'error');

            if (code === 'csrf_invalid') {
                csrfToken = null;
                await fetchCsrf();
            }

        } catch (err) {
            console.error('[login] submit failed:', err);
            showStatus('Network error. Check your connection and try again.', 'error');
        } finally {
            submitting = false;
            btn.disabled = false;
            btn.textContent = 'Log In';
        }
    });

    /* ── STEP 2: submit 2FA code ─────────────────────────────────── */
    twoFaForm.addEventListener('submit', async function (e) {
        e.preventDefault();
        if (submitting) return;
        clearStatus();

        const code = document.getElementById('code').value.trim();
        if (!code) {
            return showStatus('Please enter your code.', 'error');
        }

        if (!csrfToken) {
            await fetchCsrf();
            if (!csrfToken) return;
        }

        submitting = true;
        const btn = document.getElementById('login-2fa-btn');
        btn.disabled = true;
        btn.textContent = 'Verifying…';

        try {
            const res = await fetch(API_BASE + '/auth/login_2fa.php', {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type':    'application/json',
                    'X-CSRF-Token':    csrfToken,
                    'X-Citadel-Client': CLIENT
                },
                body: JSON.stringify({ code })
            });

            let data;
            try { data = await res.json(); }
            catch (_) { data = null; }

            if (res.status === 200 && data && data.status === 'ok' && data.user) {
                if (data.csrf_token) csrfToken = data.csrf_token;
                const note = data.via_recovery_code
                    ? ' (recovery code used)'
                    : '';
                showStatus(
                    'Welcome back, ' + data.user.username + note + '. Redirecting…',
                    'success'
                );
                setTimeout(function () {
                    window.location.href = REDIRECT;
                }, 700);
                return;
            }

            const code2   = data && data.code    ? data.code    : 'unknown_error';
            const message = data && data.message ? data.message : null;
            showStatus(friendlyMessage(code2, message), 'error');

            // If the pending session is gone, force back to step 1
            if (code2 === 'no_pending' || code2 === 'expired' || code2 === 'too_many_attempts') {
                setTimeout(showPasswordStep, 1500);
            }

        } catch (err) {
            console.error('[login_2fa] submit failed:', err);
            showStatus('Network error. Check your connection and try again.', 'error');
        } finally {
            submitting = false;
            btn.disabled = false;
            btn.textContent = 'Verify';
        }
    });

    /* ── Boot ────────────────────────────────────────────────────── */
    redirectIfLoggedIn();
    fetchCsrf();

})();