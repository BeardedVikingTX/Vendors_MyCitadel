/* ============================================================================
 * ███ FORGOT-PASSWORD.JS ███
 * ========================================================================== */
(function () {
    'use strict';

    const form = document.getElementById('forgot-form');
    if (!form) return;

    const API    = form.dataset.apiBase || 'https://api.mycitadel.lol/v1';
    const CLIENT = form.dataset.client   || 'browser/1.0.0';
    const status = document.getElementById('forgot-status');
    const btn    = document.getElementById('forgot-btn');

    let csrfToken = null;

    function setStatus(msg, kind) {
        status.textContent = msg;
        status.className = 'auth-status auth-status--' + (kind || 'info');
        status.style.display = msg ? 'block' : 'none';
    }

    async function fetchCsrf() {
        const r = await fetch(API + '/auth/csrf.php', {
            credentials: 'include',
            headers: { 'X-Citadel-Client': CLIENT }
        });
        const d = await r.json();
        if (!d.token) throw new Error('Could not start a secure session.');
        csrfToken = d.token;
        return csrfToken;
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        btn.disabled = true;
        btn.textContent = 'Sending…';
        setStatus('', 'info');

        const email = (document.getElementById('email').value || '').trim();
        if (!email) {
            setStatus('Please enter your email address.', 'error');
            btn.disabled = false;
            btn.textContent = 'Send Reset Link';
            return;
        }

        try {
            if (!csrfToken) await fetchCsrf();

            const r = await fetch(API + '/verify/password_reset_request.php', {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Citadel-Client': CLIENT,
                    'X-CSRF-Token': csrfToken
                },
                body: JSON.stringify({ email })
            });

            const d = await r.json().catch(() => ({}));

            // The API returns the same generic message for all cases —
            // account exists, doesn't exist, invalid format, or rate-limited.
            // This is intentional enumeration defense. Show it as success.
            setStatus(
                'If an account exists for that email, a reset link has been sent. ' +
                'Check your inbox (and spam folder) over the next few minutes.',
                'success'
            );

            // Clear the field but keep the page — the user may want to try
            // a different email address.
            document.getElementById('email').value = '';

        } catch (err) {
            // Only actual network/CSRF failures reach here — never user state.
            setStatus(
                'Could not reach the server. Check your connection and try again.',
                'error'
            );
        } finally {
            btn.disabled = false;
            btn.textContent = 'Send Reset Link';
        }
    });

    // Also try to warm the CSRF token on page load so the first submit
    // is instant.
    fetchCsrf().catch(() => {});
})();
