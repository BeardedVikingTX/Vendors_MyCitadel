/* ============================================================================
 * ███ DASHBOARD.JS — v2 ███
 * MyCitadel — User Dashboard
 * ----------------------------------------------------------------------------
 * Console logs every step with a [dashboard] prefix so failures are visible.
 * ========================================================================== */

(function () {
    'use strict';

    console.log('[dashboard] script loaded');

    const root = document.querySelector('.dash-root');
    if (!root) {
        console.log('[dashboard] .dash-root not found — not on dashboard page, exiting');
        return;
    }

    const API_BASE  = root.dataset.apiBase  || 'https://api.mycitadel.lol/v1';
    const CLIENT    = root.dataset.client   || 'browser/1.0.0';
    const LOGIN_URL = root.dataset.loginUrl || '/login';
    const FETCH_TIMEOUT_MS = 15000;

    const DEFAULT_AVATAR    = 'https://mycitadel.lol/img/users/default/avatar.png';
    const DEFAULT_BANNER    = 'https://mycitadel.lol/img/users/default/banner.png';
    const DEFAULT_WALLPAPER = 'https://mycitadel.lol/img/users/default/wallpaper.png';

    const loadingEl  = document.getElementById('dash-loading');
    const errorEl    = document.getElementById('dash-error');
    const errorMsgEl = document.getElementById('dash-error-msg');
    const contentEl  = document.getElementById('dash-content');
    const retryBtn   = document.getElementById('dash-retry');

    console.log('[dashboard] elements resolved:', {
        loading: !!loadingEl, error: !!errorEl, content: !!contentEl, retry: !!retryBtn
    });

    let csrfToken = null;
    let data      = null;
    const charts  = {};

    /* ── Utilities ─────────────────────────────────────────────── */
    const esc = s => s == null ? '' : String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const fmtNum = n => (Number(n) || 0).toLocaleString('en-US');
    const fmtRelative = iso => {
        if (!iso) return '—';
        const diff = (Date.now() - new Date(iso).getTime()) / 1000;
        if (diff < 60)     return 'just now';
        if (diff < 3600)   return Math.floor(diff / 60) + 'm ago';
        if (diff < 86400)  return Math.floor(diff / 3600) + 'h ago';
        if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
        return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    };
    const fmtDate = iso => !iso ? '—' : new Date(iso).toLocaleDateString('en-US', {
        month: 'long', day: 'numeric', year: 'numeric'
    });
    const greeting = () => {
        const h = new Date().getHours();
        if (h < 5)  return 'The night is still young';
        if (h < 12) return 'Good morning';
        if (h < 17) return 'Good afternoon';
        if (h < 21) return 'Good evening';
        return 'Welcome back';
    };
    const tierColor = t => ({
        bronze: '#cd7f32', silver: '#c0c0c0', gold: '#ffc72c',
        platinum: '#00f0ff', valhalla: '#b026ff'
    })[t] || '#00e5ff';
    const TIER_ORDER = ['bronze', 'silver', 'gold', 'platinum', 'valhalla'];

    /* ── State ─────────────────────────────────────────────────── */
    const showLoading = () => {
        if (loadingEl) loadingEl.hidden = false;
        if (errorEl)   errorEl.hidden   = true;
        if (contentEl) contentEl.hidden = true;
    };
    const showError = msg => {
        console.error('[dashboard] showing error:', msg);
        if (loadingEl) loadingEl.hidden = true;
        if (errorEl)   errorEl.hidden   = false;
        if (contentEl) contentEl.hidden = true;
        if (errorMsgEl) errorMsgEl.textContent = msg || 'Something went wrong.';
    };
    const showContent = () => {
        console.log('[dashboard] showing content');
        if (loadingEl) loadingEl.hidden = true;
        if (errorEl)   errorEl.hidden   = true;
        if (contentEl) contentEl.hidden = false;
    };

    /* ── CSRF ──────────────────────────────────────────────────── */
    async function fetchCsrf() {
        try {
            const res = await fetch(API_BASE + '/auth/csrf.php', {
                credentials: 'include',
                headers: { 'X-Citadel-Client': CLIENT }
            });
            if (!res.ok) return;
            const d = await res.json();
            if (d && d.status === 'ok' && d.token) csrfToken = d.token;
        } catch (_) { /* non-fatal */ }
    }

    /* ── Fetch dashboard (with timeout) ────────────────────────── */
    async function fetchDashboard() {
        console.log('[dashboard] fetching /users/dashboard.php');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        let res;
        try {
            res = await fetch(API_BASE + '/users/dashboard.php', {
                credentials: 'include',
                headers: { 'X-Citadel-Client': CLIENT },
                signal: controller.signal
            });
        } catch (err) {
            clearTimeout(timer);
            if (err.name === 'AbortError') throw new Error('Request timed out after 15s.');
            throw err;
        }
        clearTimeout(timer);

        console.log('[dashboard] response status:', res.status);

        if (res.status === 401) {
            console.log('[dashboard] unauthenticated — redirecting to login');
            window.location.href = LOGIN_URL;
            throw new Error('unauthenticated');
        }
        if (!res.ok) {
            let msg = 'Request failed (' + res.status + ').';
            try { const d = await res.json(); if (d && d.message) msg = d.message; } catch (_) {}
            throw new Error(msg);
        }
        const d = await res.json();
        if (!d || d.status !== 'ok') {
            throw new Error((d && d.message) || 'Malformed dashboard response.');
        }
        console.log('[dashboard] data received:', d);
        return d;
    }

    /* ── Wallpaper ─────────────────────────────────────────────── */
    function applyWallpaper(url) {
        const bg = url || DEFAULT_WALLPAPER;
        // Store just the URL string — the CSS adds `url(...)` around it.
        // This avoids the `url()`-inside-var() browser quirks.
        root.style.setProperty('--dash-wallpaper-url', `"${bg}"`);
        root.classList.add('dash-root--has-wallpaper');
    }

    /* ── RENDER: hero ──────────────────────────────────────────── */
    function renderHero(d) {
        const { identity: id, account } = d;
        const statuses = [];
        if (account.email_verified) statuses.push({ cls: 'ok',   label: '✓ Verified' });
        else                        statuses.push({ cls: 'warn', label: 'Unverified' });
        if (account.is_premium)     statuses.push({ cls: 'premium', label: '★ Premium' });
        statuses.push({ cls: account.is_active ? 'ok' : 'danger',
                        label: account.is_active ? '● Active' : '● Inactive' });

        const avatarUrl = id.avatar_url || DEFAULT_AVATAR;
        const bannerUrl = id.banner_url || DEFAULT_BANNER;

        document.getElementById('dash-hero').innerHTML = `
            <div class="dash-hero__banner" style="background-image:url('${esc(bannerUrl)}')"></div>
            <div class="dash-hero__inner">
                <div class="dash-hero__avatar">
                    <img src="${esc(avatarUrl)}" alt="${esc(id.username)}" class="dash-hero__avatar-img">
                </div>
                <div class="dash-hero__body">
                    <p class="dash-hero__greeting">${esc(greeting())}, ${esc(id.username)}</p>
                    <h1 class="dash-hero__name">${esc(id.display_name || id.username)}</h1>
                    ${id.tagline ? `<p class="dash-hero__tagline">${esc(id.tagline)}</p>` : ''}
                    <div class="dash-hero__meta">
                        <span>Citizen for ${esc(account.age.human)}</span>
                        <span class="dash-hero__meta-sep">·</span>
                        <span>Joined ${esc(fmtDate(account.member_since))}</span>
                        <span class="dash-hero__meta-sep">·</span>
                        <span>Last seen ${esc(fmtRelative(account.last_login_at))}</span>
                    </div>
                    <div class="dash-hero__status">
                        ${statuses.map(s => `<span class="status-pill status-pill--${s.cls}">${esc(s.label)}</span>`).join('')}
                    </div>
                </div>
            </div>
        `;
    }

    /* ── RENDER: onboarding coachmark ──────────────────────────── */
    function renderOnboarding(d) {
        const el = document.getElementById('dash-onboarding');
        const s  = d.stats;
        const activityCount = (d.activity || []).length;

        // Hide if the user has done the basics
        const isNew = s.post_count === 0 && s.connection_count === 0 && activityCount <= 2;
        if (!isNew) { el.hidden = true; return; }

        const steps = [
            { done: !!d.identity.display_name,        label: 'Set a display name',         href: '/users/profile.php' },
            { done: !!d.identity.tagline,             label: 'Add a tagline',              href: '/users/profile.php' },
            { done: d.account.email_verified,         label: 'Verify your email',          href: '/users/verify.php' },
            { done: s.post_count > 0,                 label: 'Create your first post',     href: '/feed' },
            { done: s.connection_count > 0,           label: 'Make your first connection', href: '/users/list.php' }
        ];

        el.innerHTML = `
            <div class="onboard">
                <div class="onboard__head">
                    <h2>Welcome to the Citadel</h2>
                    <p>Five quick steps to make this place yours.</p>
                </div>
                <ul class="onboard__list">
                    ${steps.map(st => `
                        <li class="onboard__step ${st.done ? 'is-done' : ''}">
                            <span class="onboard__check">${st.done ? '✓' : '○'}</span>
                            <span class="onboard__label">${esc(st.label)}</span>
                            ${st.done ? '' : `<a href="${esc(st.href)}" class="onboard__link">Go →</a>`}
                        </li>
                    `).join('')}
                </ul>
            </div>
        `;
        el.hidden = false;
    }

    /* ── RENDER: KPI strip (6 tiles) ───────────────────────────── */
    function renderKpis(d) {
        const s = d.stats, r = d.rank;
        const kpis = [
            { label: 'Reputation', value: fmtNum(s.reputation),
              sub: r.above_avg ? `▲ ${fmtNum(s.reputation - r.avg_rep)} above avg` : `avg ${fmtNum(r.avg_rep)}`,
              accent: 'gold' },
            { label: 'Rank', value: `#${fmtNum(r.position)}`,
              sub: `of ${fmtNum(r.total_users)} · top ${100 - r.percentile}%`,
              accent: 'cyan' },
            { label: 'Badges', value: fmtNum(s.badge_count),
              sub: `${fmtNum(d.community.total_badges)} available`,
              accent: 'rune' },
            { label: 'Connections', value: fmtNum(s.connection_count),
              sub: s.connection_count === 0 ? 'Reach out' : 'In your circle',
              accent: 'success' },
            { label: 'Posts', value: fmtNum(s.post_count),
              sub: s.post_count === 0 ? 'Share something' : 'Published',
              accent: 'cyan' },
            { label: 'Check-in Streak', value: fmtNum(s.checkin_streak),
              sub: s.checkin_longest_streak > 0 ? `Longest: ${fmtNum(s.checkin_longest_streak)}` : 'Start today',
              accent: 'gold' }
        ];

        document.getElementById('dash-kpis').innerHTML = kpis.map(k => `
            <div class="kpi kpi--${k.accent}">
                <p class="kpi__label">${esc(k.label)}</p>
                <p class="kpi__value">${esc(k.value)}</p>
                <p class="kpi__sub">${esc(k.sub)}</p>
            </div>
        `).join('');
    }

    /* ── RENDER: milestones ────────────────────────────────────── */
    function renderMilestones(d) {
        // For each of the top categories, find the next threshold above current value
        const s = d.stats;
        const categories = [
            { key: 'post',         label: 'Posts',        current: s.post_count,             icon: '✎' },
            { key: 'comment_given',label: 'Comments',     current: s.comment_given_count,    icon: '💬' },
            { key: 'connection',   label: 'Connections',  current: s.connection_count,       icon: '⚔' },
            { key: 'reaction_given_like',  label: 'Likes Given',  current: s.reactions.given_like,  icon: '👍' },
            { key: 'reaction_given_heart', label: 'Hearts Given', current: s.reactions.given_heart, icon: '❤' },
            { key: 'comment_received',     label: 'Replies',      current: s.comment_received_count, icon: '📨' }
        ];

        const THRESHOLDS = [1, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];

        const grid = document.getElementById('milestone-grid');
        const cards = [];

        for (const cat of categories) {
            const next = THRESHOLDS.find(t => t > cat.current);
            if (!next) continue; // maxed
            const prev = THRESHOLDS.filter(t => t <= cat.current).pop() || 0;
            const pct  = Math.max(0, Math.min(100, ((cat.current - prev) / (next - prev)) * 100));
            cards.push(`
                <div class="milestone">
                    <div class="milestone__head">
                        <span class="milestone__icon">${cat.icon}</span>
                        <span class="milestone__label">${esc(cat.label)}</span>
                    </div>
                    <div class="milestone__bar">
                        <div class="milestone__fill" style="width:${pct}%"></div>
                    </div>
                    <div class="milestone__foot">
                        <span>${fmtNum(cat.current)} / ${fmtNum(next)}</span>
                        <span class="milestone__remain">${fmtNum(next - cat.current)} to go</span>
                    </div>
                </div>
            `);
            if (cards.length >= 6) break;
        }

        if (cards.length === 0) {
            grid.innerHTML = '<p class="chart-empty">All standard milestones complete — well done, Citizen.</p>';
            return;
        }
        grid.innerHTML = cards.join('');
    }

    /* ── RENDER: security status list ──────────────────────────── */
    function renderSecurity(d) {
        const a = d.account;
        const rows = [
            { ok: a.email_verified, okText: 'Verified', failText: 'Not verified',
              label: 'Email verification',
              action: a.email_verified ? null : { href: '/users/verify.php', text: 'Verify →' } },
            { ok: false, okText: 'Enabled', failText: 'Disabled',
              label: 'Two-factor authentication',
              action: { href: '/users/2fa.php', text: 'Set Up →' } },
            { ok: a.is_active, okText: 'Active', failText: 'Inactive',
              label: 'Account status', action: null },
            { ok: !!a.last_login_at, okText: fmtRelative(a.last_login_at), failText: '—',
              label: 'Last login', action: null }
        ];

        document.getElementById('security-list').innerHTML = rows.map(r => `
            <li class="status-row ${r.ok ? 'is-ok' : 'is-warn'}">
                <span class="status-row__dot"></span>
                <span class="status-row__label">${esc(r.label)}</span>
                <span class="status-row__value">${esc(r.ok ? r.okText : r.failText)}</span>
                ${r.action ? `<a href="${esc(r.action.href)}" class="status-row__action">${esc(r.action.text)}</a>` : ''}
            </li>
        `).join('');
    }

    /* ── RENDER: profile completeness ──────────────────────────── */
    function renderCompleteness(d) {
        const id = d.identity;
        const items = [
            { label: 'Display name',  done: !!id.display_name },
            { label: 'Tagline',       done: !!id.tagline },
            { label: 'Avatar',        done: !!id.avatar_url },
            { label: 'Banner',        done: !!id.banner_url },
            { label: 'Email verified',done: !!d.account.email_verified },
            { label: 'Made a post',   done: d.stats.post_count > 0 },
            { label: 'Has a connection', done: d.stats.connection_count > 0 }
        ];
        const doneCount = items.filter(i => i.done).length;
        const pct = Math.round((doneCount / items.length) * 100);

        document.getElementById('completeness-block').innerHTML = `
            <div class="complete-ring" style="--pct:${pct};">
                <span class="complete-ring__value">${pct}%</span>
            </div>
            <ul class="complete-list">
                ${items.map(i => `
                    <li class="${i.done ? 'is-done' : ''}">
                        <span class="complete-mark">${i.done ? '✓' : '○'}</span>
                        ${esc(i.label)}
                    </li>
                `).join('')}
            </ul>
        `;
    }

    /* ── RENDER: badges gallery ────────────────────────────────── */
    function renderBadges(d) {
        const grid = document.getElementById('badge-grid');
        const badges = d.badges || [];
        document.getElementById('badges-count').textContent =
            badges.length === 0 ? 'None yet' : `${badges.length} earned`;

        if (badges.length === 0) {
            grid.innerHTML = `<div class="badge-empty">
                <p>No badges yet. Your first one is waiting — start by posting, commenting, or making connections.</p>
            </div>`;
            return;
        }

        grid.innerHTML = badges.map(b => `
            <article class="badge" style="--badge-color:${tierColor(b.tier)};">
                <div class="badge__head">
                    <span class="badge__tier">${esc(b.tier.toUpperCase())}</span>
                    ${b.is_featured ? '<span class="badge__feat" title="Featured">★</span>' : ''}
                </div>
                <h4 class="badge__name">${esc(b.name)}</h4>
                <p class="badge__desc">${esc(b.description)}</p>
                <p class="badge__meta">Earned ${esc(fmtRelative(b.earned_at))}</p>
            </article>
        `).join('');
    }

    /* ── RENDER: activity ──────────────────────────────────────── */
    function renderActivity(d) {
        const list = document.getElementById('activity-list');
        const items = d.activity || [];
        if (items.length === 0) {
            list.innerHTML = '<li class="activity-empty">No reputation events yet.</li>';
            return;
        }
        list.innerHTML = items.map(a => {
            const cls = a.delta > 0 ? 'up' : (a.delta < 0 ? 'down' : 'zero');
            const sign = a.delta > 0 ? '+' : '';
            return `
                <li class="activity-item activity-item--${cls}">
                    <span class="activity-delta">${sign}${fmtNum(a.delta)}</span>
                    <div class="activity-body">
                        <p class="activity-reason">${esc(a.reason.replace(/_/g, ' '))}</p>
                        ${a.note ? `<p class="activity-note">${esc(a.note)}</p>` : ''}
                    </div>
                    <span class="activity-time">${esc(fmtRelative(a.created_at))}</span>
                </li>
            `;
        }).join('');
    }

    /* ── RENDER: referral ──────────────────────────────────────── */
    function renderReferral(d) {
        const ref = d.stats.referrals;
        const code = ref.code || '';
        const link = `https://mycitadel.lol/register?ref=${encodeURIComponent(code)}`;
        document.getElementById('referral-code').textContent  = code || '—';
        document.getElementById('referral-link').value         = link;
        document.getElementById('referral-count').textContent  = fmtNum(ref.count);
        document.getElementById('referral-points').textContent = fmtNum(ref.points);

        const btn = document.getElementById('referral-copy');
        btn.addEventListener('click', async () => {
            try { await navigator.clipboard.writeText(link); }
            catch (_) { document.getElementById('referral-link').select(); document.execCommand('copy'); }
            btn.textContent = 'Copied';
            btn.classList.add('is-copied');
            setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('is-copied'); }, 1500);
        });
    }

    /* ── CHARTS ────────────────────────────────────────────────── */
    function initCharts(d) {
        if (typeof Chart === 'undefined') {
            console.warn('[dashboard] ChartJS not loaded — skipping charts');
            return;
        }
        console.log('[dashboard] initializing charts');

        Chart.defaults.color       = '#a0aec0';
        Chart.defaults.font.family = 'Inter, system-ui, sans-serif';
        Chart.defaults.font.size   = 12;

        const noData = (canvasId, msg) => {
            const c = document.getElementById(canvasId);
            if (c) c.parentElement.innerHTML = `<p class="chart-empty">${msg}</p>`;
        };

        /* 1. Reputation Standing */
        const repCtx = document.getElementById('chart-rep');
        if (repCtx) {
            charts.rep = new Chart(repCtx, {
                type: 'bar',
                data: {
                    labels: ['You', 'Platform Avg'],
                    datasets: [{
                        data: [d.rank.your_rep, d.rank.avg_rep],
                        backgroundColor: ['#ffc72c', 'rgba(0,229,255,0.35)'],
                        borderColor:     ['#ffc72c', 'rgba(0,229,255,0.7)'],
                        borderWidth: 1, borderRadius: 6, barThickness: 32
                    }]
                },
                options: {
                    indexAxis: 'y', responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { display: false },
                        tooltip: { callbacks: { label: c => `${c.parsed.x.toLocaleString()} rep` } } },
                    scales: {
                        x: { beginAtZero: true, grid: { color: 'rgba(0,229,255,0.08)' }, ticks: { color: '#7a8899' } },
                        y: { grid: { display: false }, ticks: { color: '#e0e6ed', font: { weight: '600' } } }
                    }
                }
            });
            const delta = d.rank.your_rep - d.rank.avg_rep;
            const sign = delta >= 0 ? '+' : '';
            document.getElementById('chart-rep-sub').textContent =
                `${sign}${fmtNum(delta)} vs platform average`;
        }

        /* 2. Badge Tiers */
        const tiers = { bronze: 0, silver: 0, gold: 0, platinum: 0, valhalla: 0 };
        (d.badges || []).forEach(b => { if (tiers[b.tier] !== undefined) tiers[b.tier]++; });
        const totalBadges = Object.values(tiers).reduce((a, b) => a + b, 0);
        const badgeCtx = document.getElementById('chart-badges');

        if (totalBadges === 0) {
            noData('chart-badges', 'Earn a badge to see your distribution.');
        } else if (badgeCtx) {
            charts.badges = new Chart(badgeCtx, {
                type: 'doughnut',
                data: {
                    labels: ['Bronze', 'Silver', 'Gold', 'Platinum', 'Valhalla'],
                    datasets: [{
                        data: TIER_ORDER.map(t => tiers[t]),
                        backgroundColor: TIER_ORDER.map(t => tierColor(t)),
                        borderColor: '#0a0e14', borderWidth: 2
                    }]
                },
                options: {
                    responsive: true, maintainAspectRatio: false, cutout: '62%',
                    plugins: { legend: { position: 'bottom',
                        labels: { color: '#a0aec0', padding: 12, boxWidth: 10, boxHeight: 10, usePointStyle: true } } }
                }
            });
        }

        /* 3. Reputation Sources (grouped from activity) */
        const sourcesMap = {};
        (d.activity || []).forEach(a => {
            if (a.delta <= 0) return;
            const key = a.reason || 'other';
            sourcesMap[key] = (sourcesMap[key] || 0) + a.delta;
        });
        const srcLabels = Object.keys(sourcesMap);
        const srcValues = srcLabels.map(k => sourcesMap[k]);
        const srcCtx = document.getElementById('chart-sources');

        if (srcLabels.length === 0) {
            noData('chart-sources', 'No reputation earned yet.');
        } else if (srcCtx) {
            const palette = ['#00e5ff', '#ffc72c', '#b026ff', '#39ff14', '#cd7f32', '#c0c0c0'];
            charts.sources = new Chart(srcCtx, {
                type: 'doughnut',
                data: {
                    labels: srcLabels.map(s => s.replace(/_/g, ' ')),
                    datasets: [{
                        data: srcValues,
                        backgroundColor: srcLabels.map((_, i) => palette[i % palette.length]),
                        borderColor: '#0a0e14', borderWidth: 2
                    }]
                },
                options: {
                    responsive: true, maintainAspectRatio: false, cutout: '62%',
                    plugins: { legend: { position: 'bottom',
                        labels: { color: '#a0aec0', padding: 12, boxWidth: 10, boxHeight: 10, usePointStyle: true } } }
                }
            });
        }

        /* 4. Trajectory */
        const events = (d.activity || []).slice().reverse();
        if (events.length < 2) {
            noData('chart-trajectory', 'Not enough activity yet. Come back after a few events.');
            return;
        }
        const trajCtx = document.getElementById('chart-trajectory');
        if (trajCtx) {
            const currentRep = d.rank.your_rep;
            const windowSum  = events.reduce((s, e) => s + (Number(e.delta) || 0), 0);
            let running      = currentRep - windowSum;
            const series     = [running];
            events.forEach(e => { running += Number(e.delta) || 0; series.push(running); });
            const labels = ['start', ...events.map(e => fmtRelative(e.created_at))];

            const grad = trajCtx.getContext('2d').createLinearGradient(0, 0, 0, 220);
            grad.addColorStop(0, 'rgba(0,229,255,0.35)');
            grad.addColorStop(1, 'rgba(0,229,255,0.02)');

            charts.traj = new Chart(trajCtx, {
                type: 'line',
                data: { labels, datasets: [{
                    data: series, borderColor: '#00e5ff', backgroundColor: grad,
                    borderWidth: 2, fill: true, tension: 0.35,
                    pointRadius: 3, pointHoverRadius: 5,
                    pointBackgroundColor: '#00e5ff', pointBorderColor: '#0a0e14', pointBorderWidth: 2
                }] },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { display: false },
                        tooltip: { callbacks: { label: c => `${c.parsed.y.toLocaleString()} rep` } } },
                    scales: {
                        x: { grid: { display: false }, ticks: { color: '#7a8899', maxRotation: 0, autoSkip: true, maxTicksLimit: 6 } },
                        y: { grid: { color: 'rgba(0,229,255,0.08)' }, ticks: { color: '#7a8899' } }
                    }
                }
            });
        }
    }

    /* ── Logout ────────────────────────────────────────────────── */
    async function doLogout() {
        const btn = document.getElementById('dash-logout');
        if (btn) btn.disabled = true;
        try {
            if (!csrfToken) await fetchCsrf();
            await fetch(API_BASE + '/auth/logout.php', {
                method: 'POST', credentials: 'include',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': csrfToken || '',
                    'X-Citadel-Client': CLIENT
                },
                body: '{}'
            });
        } catch (_) {}
        window.location.href = '/';
    }

    /* ── BOOT ──────────────────────────────────────────────────── */
    async function boot() {
        console.log('[dashboard] boot()');
        showLoading();
        applyWallpaper(DEFAULT_WALLPAPER);
        fetchCsrf();

        try {
            data = await fetchDashboard();
        } catch (err) {
            if (err.message === 'unauthenticated') return;
            console.error('[dashboard] fetch failed:', err);
            showError(err.message || 'Could not reach the API.');
            return;
        }

        try {
            renderHero(data);
            renderOnboarding(data);
            renderKpis(data);
            renderMilestones(data);
            renderSecurity(data);
            renderCompleteness(data);
            renderBadges(data);
            renderActivity(data);
            renderReferral(data);
            showContent();
            requestAnimationFrame(() => {
                try { initCharts(data); }
                catch (chartErr) { console.error('[dashboard] charts failed:', chartErr); }
            });
        } catch (err) {
            console.error('[dashboard] render failed:', err);
            showError('Layout error: ' + err.message);
        }
    }

    if (retryBtn) retryBtn.addEventListener('click', boot);
    const logoutBtn = document.getElementById('dash-logout');
    if (logoutBtn) logoutBtn.addEventListener('click', doLogout);

    boot();

})();