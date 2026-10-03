/* ============================================================================
 * ███ RESET-PASSWORD.JS ███
 * MyCitadel — Password reset step 2/3
 * ----------------------------------------------------------------------------
 * FOUR STATES:
 *   1. VERIFYING  — exchanged token with API
 *   2. FORM       — user enters new password + confirm
 *   3. SUCCESS    — password changed
 *   4. ERROR      — invalid/expired token
 *
 * TOKEN HANDLING
 *   The raw token arrives in location.hash (fragment). Fragments are never
 *   sent to the server, never logged, never leak via Referer. We read it,
 *   immediately clear it from the URL bar via replaceState, then POST it
 *   to /verify/password_reset_exchange.php. The API consumes it and sets
 *   a session flag. The final save uses the flag, not the token.
 *
 * CSRF HANDLING
 *   Same pattern as the rest of the site: fetch a token, cache it in memory,
 *   adopt any rotation the server sends back, retry once on csrf_invalid.
 * ========================================================================== */

(function () {
    'use strict';

    const API    = 'https://api.mycitadel.lol/v1';
    const CLIENT = 'browser/1.0.0';

    /* ── DOM refs ──────────────────────────────────────────────────── */
    const statusEl       = document.getElementById('reset-status');
    const verifyingEl    = document.getElementById('reset-verifying');
    const formEl         = document.getElementById('reset-form');
    const successEl      = document.getElementById('reset-success');
    const errorEl        = document.getElementById('reset-error');
    const errorTitleEl   = document.getElementById('reset-error-title');
    const errorBodyEl    = document.getElementById('reset-error-body');
    const reassureEl     = document.getElementById('reset-reassure');

    const newPwInput     = document.getElementById('new-password');
    const confirmPwInput = document.getElementById('confirm-password');
    const toggleNew      = document.getElementById('toggle-new-password');
    const toggleConfirm  = document.getElementById('toggle-confirm-password');
    const meterBar       = document.querySelector('#pw-meter .pw-meter__bar');
    const meterEl        = document.getElementById('pw-meter');
    const pwHint         = document.getElementById('pw-hint');
    const matchHint      = document.getElementById('pw-match-hint');

    const submitBtn      = document.getElementById('reset-btn');
    const submitLabel    = submitBtn ? submitBtn.querySelector('.auth-submit__label') : null;

    if (!verifyingEl || !formEl) return;

    const MIN_LEN = parseInt(formEl.dataset.minLength || '12', 10);

    /* ── Runtime state ─────────────────────────────────────────────── */
    let csrfToken   = null;
    let csrfPromise = null;
    let submitting  = false;

    /* ══════════════════════════════════════════════════════════════════
     * STATE HELPERS
     * ================================================================ */

    function showOnly(el) {
        [verifyingEl, formEl, successEl, errorEl].forEach(e => {
            if (e) e.hidden = (e !== el);
        });
        if (reassureEl) {
            // Inline style, because the base CSS sets display:grid which
            // overrides the [hidden] attribute.
            reassureEl.style.display = (el === formEl) ? 'grid' : 'none';
        }
    }

    function setStatus(msg, kind) {
        if (!msg) {
            statusEl.style.display = 'none';
            statusEl.textContent = '';
            return;
        }
        statusEl.textContent = msg;
        statusEl.className = 'auth-status auth-status--' + (kind || 'info');
        statusEl.style.display = 'block';
    }

    function showError(title, body) {
        if (errorTitleEl && title) errorTitleEl.textContent = title;
        if (errorBodyEl && body)  errorBodyEl.textContent = body;
        showOnly(errorEl);
    }

    /* ══════════════════════════════════════════════════════════════════
     * CSRF
     * ================================================================ */

    async function fetchCsrf() {
        if (csrfToken) return csrfToken;
        if (csrfPromise) return csrfPromise;

        csrfPromise = (async () => {
            try {
                const r = await fetch(API + '/auth/csrf.php', {
                    credentials: 'include',
                    headers: { 'X-Citadel-Client': CLIENT }
                });
                const d = await r.json();
                if (d && d.status === 'ok' && d.token) {
                    csrfToken = d.token;
                    return csrfToken;
                }
            } catch (_) {}
            csrfPromise = null;
            return null;
        })();

        return csrfPromise;
    }

    /**
     * POST with automatic csrf_invalid retry (once).
     */
    async function postWithCsrf(path, body) {
        let token = await fetchCsrf();
        if (!token) throw new Error('Could not establish a secure session.');

        const attempt = async (t) => fetch(API + path, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json',
                'X-Citadel-Client': CLIENT,
                'X-CSRF-Token': t
            },
            body: JSON.stringify(body)
        });

        let r = await attempt(token);
        let data = null;
        try { data = await r.json(); } catch (_) {}

        if (r.status === 403 && data && data.code === 'csrf_invalid') {
            csrfToken = null;
            csrfPromise = null;
            token = await fetchCsrf();
            if (!token) throw new Error('Could not establish a secure session.');
            r = await attempt(token);
            try { data = await r.json(); } catch (_) {}
        }

        if (data && typeof data.csrf_token === 'string' && data.csrf_token) {
            csrfToken = data.csrf_token;
        }

        return { response: r, data: data || {} };
    }

    /* ══════════════════════════════════════════════════════════════════
     * STEP 1 — EXCHANGE TOKEN FROM FRAGMENT
     * ================================================================ */

    function readAndStripToken() {
        const hash = window.location.hash || '';
        const m = hash.match(/token=([a-f0-9]{64})/i);

        // Clear the fragment IMMEDIATELY, before anything else, so a
        // same-origin script or a screenshot or the browser's URL bar
        // never shows the raw token.
        if (hash) {
            history.replaceState({}, '', window.location.pathname);
        }

        return m ? m[1] : null;
    }

    async function verifyToken(rawToken) {
        showOnly(verifyingEl);
        setStatus('');

        if (!rawToken) {
            showError(
                'Link Missing',
                'This page needs to be reached from a password reset email. ' +
                'If you have a link, click it again from your inbox.'
            );
            return;
        }

        try {
            const { response, data } = await postWithCsrf(
                '/verify/password_reset_exchange.php',
                { token: rawToken }
            );

            if (!response.ok) {
                if (data.code === 'invalid_token' || response.status === 400) {
                    showError(
                        'Link Expired or Invalid',
                        'This reset link is invalid, has already been used, ' +
                        'or has expired. Reset links are valid for 15 minutes ' +
                        'and can only be used once.'
                    );
                } else {
                    showError(
                        'Could Not Verify Link',
                        data.message || 'Something went wrong. Please request a new link.'
                    );
                }
                return;
            }

            // Success — show the form
            showOnly(formEl);
            newPwInput.focus();

        } catch (err) {
            showError(
                'Network Error',
                'Could not reach the server. Check your connection and try again.'
            );
        }
    }

    /* ══════════════════════════════════════════════════════════════════
     * PASSWORD STRENGTH METER
     * ================================================================ */

    function scorePassword(pw) {
        if (!pw) return 0;
        let score = 0;
        if (pw.length >= 12) score += 1;
        if (pw.length >= 16) score += 1;
        if (pw.length >= 20) score += 1;
        if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score += 1;
        if (/\d/.test(pw)) score += 1;
        if (/[^A-Za-z0-9]/.test(pw)) score += 1;
        return Math.min(score, 6);
    }

    function updateMeter() {
        const pw = newPwInput.value || '';
        const score = scorePassword(pw);

        if (meterBar) {
            meterBar.setAttribute('data-level', String(score));
            meterBar.style.width = (score / 6 * 100) + '%';
        }
        if (meterEl) {
            meterEl.setAttribute('aria-valuenow', String(score));
        }

        if (pwHint) {
            if (pw.length === 0) {
                pwHint.textContent =
                    `Minimum ${MIN_LEN} characters. A passphrase of three or ` +
                    `four random words is stronger than a short complex string.`;
            } else if (pw.length < MIN_LEN) {
                pwHint.textContent = `${MIN_LEN - pw.length} more character${
                    MIN_LEN - pw.length === 1 ? '' : 's'} needed.`;
            } else if (score <= 2) {
                pwHint.textContent = 'Good length. Add variety or more words to strengthen.';
            } else if (score <= 4) {
                pwHint.textContent = 'Strong password.';
            } else {
                pwHint.textContent = 'Excellent. This is a very strong password.';
            }
        }

        updateMatchHint();
        updateSubmitState();
    }

    function updateMatchHint() {
        if (!matchHint) return;
        const pw = newPwInput.value || '';
        const confirm = confirmPwInput.value || '';

        if (confirm.length === 0) {
            matchHint.textContent = '';
            matchHint.className = 'auth-hint';
            return;
        }

        if (pw === confirm) {
            matchHint.textContent = '✓ Passwords match';
            matchHint.className = 'auth-hint auth-hint--ok';
        } else {
            matchHint.textContent = '✗ Passwords do not match yet';
            matchHint.className = 'auth-hint auth-hint--error';
        }
    }

    function updateSubmitState() {
        if (!submitBtn) return;
        const pw = newPwInput.value || '';
        const confirm = confirmPwInput.value || '';
        const ok = pw.length >= MIN_LEN && pw === confirm;
        submitBtn.disabled = !ok || submitting;
    }

    /* ══════════════════════════════════════════════════════════════════
     * VISIBILITY TOGGLES
     * ================================================================ */

    function wireToggle(btn, input) {
        if (!btn || !input) return;
        btn.addEventListener('click', () => {
            const showing = input.type === 'text';
            input.type = showing ? 'password' : 'text';
            btn.setAttribute('aria-pressed', String(!showing));
            btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
        });
    }

    /* ══════════════════════════════════════════════════════════════════
     * STEP 2 — SUBMIT NEW PASSWORD
     * ================================================================ */

    async function submitNewPassword() {
        if (submitting) return;

        const pw      = newPwInput.value || '';
        const confirm = confirmPwInput.value || '';

        setStatus('');

        if (pw.length < MIN_LEN) {
            setStatus(`Password must be at least ${MIN_LEN} characters.`, 'error');
            newPwInput.focus();
            return;
        }
        if (pw !== confirm) {
            setStatus('Passwords do not match.', 'error');
            confirmPwInput.focus();
            return;
        }

        submitting = true;
        if (submitLabel) submitLabel.textContent = 'Saving…';
        if (submitBtn) submitBtn.disabled = true;

        try {
            const { response, data } = await postWithCsrf(
                '/verify/password_reset_consume.php',
                { password: pw }
            );

            if (!response.ok) {
                if (data.code === 'weak_password') {
                    setStatus(data.message || 'That password is not strong enough.', 'error');
                } else if (data.code === 'password_unchanged') {
                    setStatus('Your new password must be different from your old one.', 'error');
                } else if (data.code === 'no_authorization' || data.code === 'authorization_expired') {
                    showError(
                        'Session Expired',
                        'Your reset session timed out. Please request a new reset link.'
                    );
                    return;
                } else {
                    setStatus(data.message || 'Could not save the new password.', 'error');
                }
                submitting = false;
                if (submitLabel) submitLabel.textContent = 'Save New Password';
                updateSubmitState();
                return;
            }

            // Success
            showOnly(successEl);

            // Optional: auto-redirect to dashboard after a moment. Some
            // users prefer to click. We'll redirect after 6 seconds if the
            // user hasn't navigated yet.
            setTimeout(() => {
                if (document.visibilityState === 'visible' && !successEl.hidden) {
                    window.location.href = '/users/dashboard.php';
                }
            }, 6000);

        } catch (err) {
            setStatus(
                'Could not reach the server. Check your connection and try again.',
                'error'
            );
            submitting = false;
            if (submitLabel) submitLabel.textContent = 'Save New Password';
            updateSubmitState();
        }
    }

    /* ══════════════════════════════════════════════════════════════════
     * WIRE
     * ================================================================ */

    wireToggle(toggleNew, newPwInput);
    wireToggle(toggleConfirm, confirmPwInput);

    if (newPwInput)     newPwInput.addEventListener('input', updateMeter);
    if (confirmPwInput) confirmPwInput.addEventListener('input', updateMeter);

    formEl.addEventListener('submit', (e) => {
        e.preventDefault();
        submitNewPassword();
    });

    /* ══════════════════════════════════════════════════════════════════
     * BOOT
     * ================================================================ */

    const rawToken = readAndStripToken();
    verifyToken(rawToken);

})();