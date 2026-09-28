/* ============================================================================
 * ███ REGISTER.JS ███
 * MyCitadel — Registration flow
 * ----------------------------------------------------------------------------
 * Loaded externally so it satisfies the page CSP (script-src 'self').
 * Reads config from data-* attributes on #register-form.
 * ========================================================================== */

(function () {
    'use strict';

    const form      = document.getElementById('register-form');
    if (!form) return;

    const API_BASE  = form.dataset.apiBase  || 'https://api.mycitadel.lol/v1';
    const CLIENT    = form.dataset.client   || 'browser/1.0.0';
    const REDIRECT  = form.dataset.redirect || '/dashboard';

    const statusEl  = document.getElementById('register-status');
    const submitBtn = document.getElementById('register-btn');
    const pwInput   = document.getElementById('password');
    const pwConfirm = document.getElementById('password_confirm');
    const pwMeter   = document.querySelector('.pw-meter__bar');
    const pwHint    = document.getElementById('pw-hint');

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

    /* ── Fetch a CSRF token from the API ─────────────────────────── */
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
            console.info('[register] CSRF token minted');
        } catch (err) {
            console.error('[register] CSRF fetch failed:', err);
            showStatus(
                'Could not reach the API. Check your connection and reload the page.',
                'error'
            );
        }
    }

    /* ── Password strength meter ─────────────────────────────────── */
    function scorePassword(pw) {
        let score = 0;
        if (pw.length >= 12) score += 1;
        if (pw.length >= 16) score += 1;
        if (pw.length >= 20) score += 1;
        if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score += 1;
        if (/\d/.test(pw)) score += 1;
        if (/[^A-Za-z0-9]/.test(pw)) score += 1;
        return Math.min(score, 6);
    }

    if (pwInput && pwMeter && pwHint) {
        pwInput.addEventListener('input', function () {
            const s = scorePassword(pwInput.value);
            pwMeter.dataset.level = String(s);
            pwMeter.style.width = Math.min(100, (s / 6) * 100) + '%';

            if (pwInput.value.length === 0) {
                pwHint.textContent = 'Minimum 12 characters. A passphrase of three or four random words is stronger than a short complex string.';
            } else if (pwInput.value.length < 12) {
                pwHint.textContent = (12 - pwInput.value.length) + ' more characters needed.';
            } else if (s <= 2) {
                pwHint.textContent = 'Good length. Add variety (caps, numbers, symbols) or more words.';
            } else {
                pwHint.textContent = 'Strong.';
            }
        });
    }

    /* ── Form submission ─────────────────────────────────────────── */
    form.addEventListener('submit', async function (e) {
        e.preventDefault();
        if (submitting) return;

        clearStatus();

        const username = document.getElementById('username').value.trim();
        const email    = document.getElementById('email').value.trim();
        const password = pwInput.value;
        const confirm  = pwConfirm.value;
        const referral = document.getElementById('referral_code').value.trim();
        const terms    = document.getElementById('accept_terms').checked;
        const age      = document.getElementById('accept_age').checked;

        if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
            return showStatus('Username must be 3–32 characters: letters, numbers, underscores only.', 'error');
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return showStatus('Please enter a valid email address.', 'error');
        }
        if (password.length < 12) {
            return showStatus('Password must be at least 12 characters.', 'error');
        }
        if (password !== confirm) {
            return showStatus('Passwords do not match.', 'error');
        }
        if (!terms) {
            return showStatus('You must accept the Terms of Service to register.', 'error');
        }
        if (!age) {
            return showStatus('You must confirm you are at least 13 years old.', 'error');
        }

        if (!csrfToken) {
            await fetchCsrf();
            if (!csrfToken) return;
        }

        submitting = true;
        submitBtn.disabled = true;
        submitBtn.textContent = 'Creating account…';

        const payload = { username, email, password };
        if (referral) payload.referral_code = referral;

        try {
            const res = await fetch(API_BASE + '/auth/register.php', {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': csrfToken,
                    'X-Citadel-Client': CLIENT
                },
                body: JSON.stringify(payload)
            });

            let data;
            try { data = await res.json(); }
            catch (_) { data = null; }

            if ((res.status === 201 || res.status === 200) && data && data.status === 'ok') {
                showStatus(
                    'Welcome to the Citadel, ' + (data.user && data.user.username ? data.user.username : username) + '. Redirecting…',
                    'success'
                );
                setTimeout(function () {
                    window.location.href = REDIRECT;
                }, 900);
                return;
            }

            const code    = data && data.code    ? data.code    : 'unknown_error';
            const message = data && data.message ? data.message : 'Something went wrong. Please try again.';

            const messages = {
                missing_fields:      'All fields are required.',
                invalid_username:    'Username must be 3–32 characters: letters, numbers, underscores only.',
                reserved_username:   'That username is reserved. Please choose another.',
                invalid_email:       'Please enter a valid email address.',
                weak_password:       message,
                user_exists:         'That username or email is already registered. Try logging in instead.',
                rate_limited:        'Too many attempts from this network. Try again in an hour.',
                csrf_invalid:        'Your session expired. Reload the page and try again.',
                origin_required:     'Request blocked by the API gate. Reload the page and try again.',
                registration_failed: 'We could not create your account. Please try again in a moment.'
            };

            showStatus(messages[code] || message, 'error');

            if (code === 'csrf_invalid') {
                csrfToken = null;
                await fetchCsrf();
            }

        } catch (err) {
            console.error('[register] submit failed:', err);
            showStatus('Network error. Check your connection and try again.', 'error');
        } finally {
            submitting = false;
            submitBtn.disabled = false;
            submitBtn.textContent = 'Create Account';
        }
    });

    /* ── Boot ────────────────────────────────────────────────────── */
    fetchCsrf();

})();