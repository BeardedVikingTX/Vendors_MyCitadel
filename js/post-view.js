/* ============================================================================
 * ███ POST-VIEW.JS ███
 * Single post permalink view.
 * ========================================================================== */

(function () {
    'use strict';

    const root = document.querySelector('.post-view-root');
    if (!root) return;

    const API_BASE  = root.dataset.apiBase  || 'https://api.mycitadel.lol/v1';
    const CLIENT    = root.dataset.client   || 'browser/1.0.0';
    const POST_ID   = parseInt(root.dataset.postId, 10);

    const loadingEl = document.getElementById('post-view-loading');
    const errorEl   = document.getElementById('post-view-error');
    const shellEl   = document.getElementById('post-view-shell');
    const cardEl    = document.getElementById('post-view-card');

    let csrfToken = null;
    let currentUser = null;

    const esc = s => s == null ? '' : String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    function fmtFull(iso) {
        return new Date(iso).toLocaleString('en-US', {
            month: 'long', day: 'numeric', year: 'numeric',
            hour: 'numeric', minute: '2-digit'
        });
    }

    function initialsOf(n) {
        if (!n) return '?';
        const p = String(n).trim().split(/\s+/);
        return p.length === 1 ? p[0].slice(0, 2).toUpperCase()
            : (p[0][0] + p[p.length - 1][0]).toUpperCase();
    }

    async function api(method, path) {
        const headers = { 'X-Citadel-Client': CLIENT };
        if (method !== 'GET') {
            if (!csrfToken) {
                const r = await fetch(API_BASE + '/auth/csrf.php', {
                    credentials: 'include',
                    headers: { 'X-Citadel-Client': CLIENT },
                });
                const d = await r.json();
                if (d && d.token) csrfToken = d.token;
            }
            if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
        }
        const res = await fetch(API_BASE + path, { credentials: 'include', headers });
        const data = await res.json();
        if (res.status === 401) {
            window.location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
            throw new Error('unauthenticated');
        }
        if (!res.ok || !data || data.status === 'error') {
            throw new Error((data && data.message) || 'Request failed');
        }
        return data;
    }

    function render(post) {
        const isOwn = currentUser && post.user_id === currentUser.id;
        const avatar = post.author_avatar_url
            ? `<img src="${esc(post.author_avatar_url)}" alt="">`
            : `<span>${esc(initialsOf(post.author_display_name || post.author_username))}</span>`;

        cardEl.innerHTML = `
            <article class="post post--single">
                <header class="post__head">
                    <a href="/users/view.php?id=${post.user_id}" class="post__avatar">${avatar}</a>
                    <div class="post__who">
                        <a href="/users/view.php?id=${post.user_id}" class="post__name">
                            ${esc(post.author_display_name || post.author_username)}
                        </a>
                        <div class="post__meta">
                            <span>@${esc(post.author_username)}</span>
                            <span class="post__dot">·</span>
                            <time>${esc(fmtFull(post.created_at))}</time>
                            ${post.is_edited ? `<span class="post__edited">· edited</span>` : ''}
                        </div>
                    </div>
                </header>
                <div class="post__body">
                    <p class="post__content">${esc(post.content)}</p>
                </div>
                ${isOwn ? `
                    <footer class="post__foot">
                        <a href="/feed" class="post__link">Manage in feed →</a>
                    </footer>
                ` : ''}
            </article>
        `;
    }

    async function boot() {
        if (!POST_ID) {
            loadingEl.hidden = true;
            errorEl.hidden = false;
            return;
        }
        try {
            const me = await api('GET', '/users/me.php');
            currentUser = me.user;
            const data = await api('GET', '/posts/view.php?id=' + POST_ID);
            render(data.post);
            loadingEl.hidden = true;
            shellEl.hidden = false;
        } catch (e) {
            console.error('[post-view]', e);
            loadingEl.hidden = true;
            errorEl.hidden = false;
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

})();