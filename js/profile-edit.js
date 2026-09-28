/* ============================================================================
 * ███ PROFILE-EDIT.JS ███
 * MyCitadel — Profile Editor
 * ----------------------------------------------------------------------------
 * Loads the current profile via /users/profile.php, renders 12 sections,
 * autosaves text fields on blur (debounced), uploads images immediately.
 * ========================================================================== */

(function () {
    'use strict';

    /* ── DOM refs ──────────────────────────────────────────────────── */
    const root       = document.querySelector('.edit-root');
    if (!root) return;

    const loadingEl  = document.getElementById('edit-loading');
    const errorEl    = document.getElementById('edit-error');
    const errorMsgEl = document.getElementById('edit-error-msg');
    const retryBtn   = document.getElementById('edit-retry');
    const shellEl    = document.getElementById('edit-shell');
    const navListEl  = document.getElementById('edit-nav-list');
    const contentEl  = document.getElementById('edit-content');
    const toastLayer = document.getElementById('edit-toast-layer');
    const navTitle   = document.getElementById('edit-nav-title');
    const navHandle  = document.getElementById('edit-nav-handle');

    const API_BASE = root.dataset.apiBase || 'https://api.mycitadel.lol/v1';
    const CLIENT   = root.dataset.client || 'browser/1.0.0';
    const LOGIN    = root.dataset.loginUrl || '/login';

    /* ── State ─────────────────────────────────────────────────────── */
    let profile = null;
    let options = null;
    let csrfToken = null;
    const saveTimers = new Map();
    const dirty = new Set();
    const SECTIONS = [
        { key: 'identity',  label: 'Identity' },
        { key: 'images',    label: 'Images' },
        { key: 'location',  label: 'Location' },
        { key: 'personal',  label: 'Personal' },
        { key: 'work',      label: 'Work' },
        { key: 'life',      label: 'Life' },
        { key: 'interests', label: 'Interests' },
        { key: 'favorites', label: 'Favorites' },
        { key: 'links',     label: 'Links' },
        { key: 'theme',     label: 'Theme' },
        { key: 'privacy',   label: 'Privacy' },
        { key: 'account',   label: 'Account' },
    ];

    /* ══════════════════════════════════════════════════════════════════
     * UTILITIES
     * ════════════════════════════════════════════════════════════════ */

    function log(...args) { console.log('[edit]', ...args); }
    function err(...args) { console.error('[edit]', ...args); }

    /* ══════════════════════════════════════════════════════════════════
     * TOASTS
     * ════════════════════════════════════════════════════════════════ */

    function toast(message, kind = 'info', duration = 2600) {
        const el = document.createElement('div');
        el.className = `edit-toast edit-toast--${kind}`;
        el.textContent = message;
        toastLayer.appendChild(el);
        requestAnimationFrame(() => el.classList.add('is-visible'));
        setTimeout(() => {
            el.classList.remove('is-visible');
            setTimeout(() => el.remove(), 220);
        }, duration);
    }

    /* ══════════════════════════════════════════════════════════════════
     * CSRF
     * ════════════════════════════════════════════════════════════════ */

    async function fetchCsrf() {
        try {
            const res = await fetch(`${API_BASE}/auth/csrf.php`, {
                credentials: 'include',
                headers: { 'X-Citadel-Client': CLIENT },
            });
            if (!res.ok) return null;
            const d = await res.json();
            if (d && d.status === 'ok' && d.token) csrfToken = d.token;
            return csrfToken;
        } catch (e) {
            err('CSRF fetch failed', e);
            return null;
        }
    }

    async function api(method, path, body = null, isFormData = false) {
        const headers = { 'X-Citadel-Client': CLIENT };
        if (!isFormData && body !== null) headers['Content-Type'] = 'application/json';
        if (method !== 'GET') {
            if (!csrfToken) await fetchCsrf();
            if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
        }

        const res = await fetch(API_BASE + path, {
            method,
            credentials: 'include',
            headers,
            body: isFormData ? body : (body === null ? undefined : JSON.stringify(body)),
        });

        let data = null;
        try { data = await res.json(); } catch (_) {}

        if (res.status === 401) {
            window.location.href = `${LOGIN}?next=/users/edit.php`;
            throw new Error('unauthenticated');
        }
        if (!res.ok || !data || data.status === 'error') {
            const msg = (data && data.message) || `Request failed (${res.status})`;
            const error = new Error(msg);
            error.code = data && data.code;
            throw error;
        }
        return data;
    }

    /* ══════════════════════════════════════════════════════════════════
     * LOAD PROFILE + OPTIONS
     * ════════════════════════════════════════════════════════════════ */

    async function loadProfile() {
        log('loading profile…');
        // Fetch profile (all the profile fields) + me (username, email, reputation)
        // in parallel — two round-trips, half the wait.
        const [profileData, meData] = await Promise.all([
            api('GET', '/users/profile.php'),
            api('GET', '/users/me.php'),
        ]);
    
        profile = profileData.profile || {};
        options = profileData.options || {};
    
        // Merge in user-level fields from /me.php
        if (meData.user) {
            profile.username       = meData.user.username;
            profile.email          = meData.user.email;
            profile.reputation     = meData.user.reputation;
            profile.premium        = meData.user.premium;
            profile.email_verified = meData.user.email_verified;
        }
    
        log('profile loaded', profile);
        log('options loaded', options);
    }

    /* ══════════════════════════════════════════════════════════════════
     * POPULATE FORM
     * ════════════════════════════════════════════════════════════════ */

    function populateForm() {
        // Text / number / date / url / email inputs
        contentEl.querySelectorAll('[data-field]').forEach(el => {
            const key = el.dataset.field;
            const val = profile[key];

            if (el.type === 'checkbox') {
                el.checked = !!val;
            } else if (el.type === 'range') {
                const n = Number(val);
                el.value = isFinite(n) ? n : (el.min || 0);
                updateRangeCounter(el);
            } else if (el.tagName === 'SELECT' && el.dataset.options) {
                const optionList = options[el.dataset.options] || [];
                fillSelect(el, optionList, val);
            } else if (el.tagName === 'SELECT') {
                el.value = val || '';
            } else {
                el.value = val == null ? '' : String(val);
            }
        });

        // Bio and other counters
        updateCounter('bio', profile.bio || '');

        // List editors (favorites)
        contentEl.querySelectorAll('[data-list]').forEach(el => {
            const key = el.dataset.list;
            renderListEditor(el, Array.isArray(profile[key]) ? profile[key] : []);
        });

        // Chips (looking_for)
        contentEl.querySelectorAll('[data-chips]').forEach(el => {
            const key = el.dataset.chips;
            const selected = Array.isArray(profile[key]) ? profile[key] : [];
            renderChipGroup(el, key, selected);
        });

        // Privacy toggles
        contentEl.querySelectorAll('[data-toggle]').forEach(el => {
            el.checked = !!profile[el.dataset.toggle];
        });
        const visSelect = document.getElementById('edit-visibility-select');
        if (visSelect) visSelect.value = profile.visibility || 'public';

        // Images
        ['avatar', 'banner', 'wallpaper'].forEach(kind => {
            const url = profile[`${kind}_url`];
            const img = contentEl.querySelector(`[data-image-preview="${kind}"]`);
            const placeholder = contentEl.querySelector(`[data-image-placeholder="${kind}"]`);
            if (url && img) {
                img.src = url;
                img.hidden = false;
                if (placeholder) placeholder.hidden = true;
            }
        });

        // Account header
        navTitle.textContent = profile.display_name || profile.username || 'Citizen';
        navHandle.textContent = '@' + (profile.username || '');
        document.getElementById('edit-username').value = profile.username || '';
        document.getElementById('edit-email').value = profile.email || '';
    }

    function fillSelect(select, optionList, current) {
        select.innerHTML = '';
        const blank = document.createElement('option');
        blank.value = '';
        blank.textContent = '— Not set —';
        select.appendChild(blank);

        optionList.forEach(opt => {
            const o = document.createElement('option');
            o.value = opt;
            o.textContent = humanize(opt);
            select.appendChild(o);
        });

        if (current != null && current !== '') {
            // If the current value isn't in the option list, add it so we don't lose it
            const exists = Array.from(select.options).some(o => o.value === current);
            if (!exists) {
                const o = document.createElement('option');
                o.value = current;
                o.textContent = humanize(current);
                select.appendChild(o);
            }
            select.value = current;
        }
    }

    function humanize(s) {
        return String(s).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }

    /* ══════════════════════════════════════════════════════════════════
     * LIST EDITOR (favorites — array of strings)
     * ════════════════════════════════════════════════════════════════ */

    function renderListEditor(container, values) {
        container.innerHTML = '';
        const items = values.length ? values : [''];

        items.forEach((v, i) => container.appendChild(makeListRow(v, i)));

        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'edit-list-editor__add';
        addBtn.textContent = '+ Add';
        addBtn.addEventListener('click', () => {
            container.insertBefore(makeListRow('', container.children.length), addBtn);
        });
        container.appendChild(addBtn);
    }

    function makeListRow(value, index) {
        const row = document.createElement('div');
        row.className = 'edit-list-editor__row';

        const input = document.createElement('input');
        input.type = 'text';
        input.value = value;
        input.placeholder = 'Add an entry…';
        input.maxLength = 128;
        input.dataset.listItem = '';

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'edit-list-editor__remove';
        remove.textContent = '×';
        remove.addEventListener('click', () => {
            row.remove();
            scheduleSave('favorite_list_' + (row.closest('[data-list]')?.dataset.list || ''));
        });

        row.appendChild(input);
        row.appendChild(remove);
        return row;
    }

    /* ══════════════════════════════════════════════════════════════════
     * CHIP GROUP (looking_for — array of enum values)
     * ════════════════════════════════════════════════════════════════ */

    function renderChipGroup(container, fieldKey, selected) {
        container.innerHTML = '';
        const all = options.looking_for_options || [];
        all.forEach(opt => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'edit-chip';
            chip.textContent = humanize(opt);
            chip.dataset.value = opt;
            if (selected.includes(opt)) chip.classList.add('is-selected');
            chip.addEventListener('click', () => {
                chip.classList.toggle('is-selected');
                scheduleSave(fieldKey, 200);
            });
            container.appendChild(chip);
        });
    }

    function collectChips(fieldKey) {
        const container = contentEl.querySelector(`[data-chips="${fieldKey}"]`);
        if (!container) return [];
        return Array.from(container.querySelectorAll('.edit-chip.is-selected'))
            .map(c => c.dataset.value);
    }

    /* ══════════════════════════════════════════════════════════════════
     * SAVE LOGIC
     * ════════════════════════════════════════════════════════════════ */

    /**
     * Schedule a debounced save. Called from blur handlers and chip clicks.
     * Collects all currently-dirty fields into a single POST.
     */
    function scheduleSave(fieldKey, delay = 400) {
        dirty.add(fieldKey);
        if (saveTimers.has('global')) clearTimeout(saveTimers.get('global'));
        saveTimers.set('global', setTimeout(flushSave, delay));
    }

    async function flushSave() {
        saveTimers.delete('global');
        if (!dirty.size) return;

        const payload = buildPayload();
        const touched = Array.from(dirty);
        dirty.clear();

        if (Object.keys(payload).length === 0) return;

        log('saving', touched, payload);

        try {
            await api('POST', '/users/profile_update.php', payload);
            toast('Saved ✓', 'success', 1600);

            // Update local mirror so subsequent reads are accurate
            Object.assign(profile, payload);
        } catch (e) {
            err('save failed', e);
            toast(e.message || 'Save failed', 'error', 3200);
            // Re-populate the offending fields so the user sees the server state
            populateForm();
        }
    }

    /**
     * Build the profile_update payload from all dirty fields.
     * Only fields that map 1:1 to the API are included.
     */
    function buildPayload() {
        const p = {};
        dirty.forEach(key => {
            // Favorites lists
            if (key.startsWith('favorite_list_')) {
                const listKey = key.replace('favorite_list_', '');
                const container = contentEl.querySelector(`[data-list="${listKey}"]`);
                if (container) {
                    p[listKey] = Array.from(container.querySelectorAll('[data-list-item]'))
                        .map(i => i.value.trim())
                        .filter(v => v.length > 0);
                }
                return;
            }

            // Chip group
            if (key === 'looking_for') {
                p.looking_for = collectChips('looking_for');
                return;
            }

            // Standard field
            const el = contentEl.querySelector(`[data-field="${key}"]`);
            if (!el) return;

            if (el.type === 'checkbox') {
                p[key] = el.checked;
            } else if (el.type === 'number' || el.type === 'range') {
                const n = Number(el.value);
                p[key] = isFinite(n) ? n : null;
            } else {
                const v = el.value.trim();
                p[key] = v === '' ? null : v;
            }
        });
        return p;
    }

    /* ══════════════════════════════════════════════════════════════════
     * PRIVACY SETTINGS (separate endpoint)
     * ════════════════════════════════════════════════════════════════ */

    async function savePrivacy() {
        const visibility = document.getElementById('edit-visibility-select').value;
        const privacy_toggles = {};
        contentEl.querySelectorAll('[data-toggle]').forEach(el => {
            privacy_toggles[el.dataset.toggle] = el.checked;
        });
        try {
            await api('POST', '/users/settings.php', { visibility, privacy_toggles });
            toast('Privacy settings saved ✓', 'success', 1600);
        } catch (e) {
            toast(e.message || 'Save failed', 'error', 3200);
        }
    }

    /* ══════════════════════════════════════════════════════════════════
     * IMAGE UPLOAD
     * ════════════════════════════════════════════════════════════════ */

    async function uploadImage(kind, file) {
        if (!file) return;

        // Client-side size guard (5 MB matches the server limit)
        if (file.size > 5 * 1024 * 1024) {
            toast('Image exceeds 5 MB.', 'error', 3200);
            return;
        }
        const okTypes = ['image/jpeg', 'image/png', 'image/webp'];
        if (!okTypes.includes(file.type)) {
            toast('Only JPEG, PNG, and WebP are accepted.', 'error', 3200);
            return;
        }

        // Optimistic preview
        const preview = contentEl.querySelector(`[data-image-preview="${kind}"]`);
        const placeholder = contentEl.querySelector(`[data-image-placeholder="${kind}"]`);
        const reader = new FileReader();
        reader.onload = e => {
            if (preview) {
                preview.src = e.target.result;
                preview.hidden = false;
                if (placeholder) placeholder.hidden = true;
            }
        };
        reader.readAsDataURL(file);

        // POST multipart
        const fd = new FormData();
        fd.append('file', file);

        toast(`Uploading ${kind}…`, 'info', 2000);
        try {
            const result = await api('POST', `/upload/${kind}.php`, fd, true);
            if (result.url && preview) preview.src = result.url;
            // Update local state so subsequent renders stay consistent
            profile[`${kind}_url`] = result.url;
            toast(`${kind.charAt(0).toUpperCase() + kind.slice(1)} updated ✓`, 'success', 1800);
        } catch (e) {
            err('upload failed', e);
            toast(e.message || 'Upload failed', 'error', 3200);
            // Revert preview
            const url = profile[`${kind}_url`];
            if (url) {
                if (preview) preview.src = url;
            } else {
                if (preview) preview.hidden = true;
                if (placeholder) placeholder.hidden = false;
            }
        }
    }

    /* ══════════════════════════════════════════════════════════════════
     * ACCOUNT (username, email, password)
     * ════════════════════════════════════════════════════════════════ */

    function wireAccountSection() {
        const usernameInput = document.getElementById('edit-username');
        const emailInput = document.getElementById('edit-email');
        const currentPw = document.getElementById('edit-current-password');
        const newPw = document.getElementById('edit-new-password');
        const newPwConfirm = document.getElementById('edit-new-password-confirm');
        const saveUsername = document.getElementById('edit-save-username');
        const saveEmail = document.getElementById('edit-save-email');
        const savePassword = document.getElementById('edit-save-password');

        if (usernameInput) {
            usernameInput.addEventListener('input', () => {
                saveUsername.disabled = usernameInput.value.trim() === (profile.username || '');
            });
        }
        if (emailInput) {
            emailInput.addEventListener('input', () => {
                saveEmail.disabled = emailInput.value.trim() === (profile.email || '');
            });
        }
        if (currentPw && newPw && newPwConfirm) {
            const evaluate = () => {
                const ok = currentPw.value.length > 0 &&
                           newPw.value.length >= 12 &&
                           newPw.value === newPwConfirm.value;
                savePassword.disabled = !ok;
            };
            [currentPw, newPw, newPwConfirm].forEach(el => el.addEventListener('input', evaluate));
        }

        saveUsername?.addEventListener('click', async () => {
            const v = usernameInput.value.trim();
            if (!/^[a-zA-Z0-9_]{3,32}$/.test(v)) {
                toast('Username must be 3–32 chars: letters, numbers, underscores.', 'error', 3200);
                return;
            }
            saveUsername.disabled = true;
            try {
                await api('POST', '/users/update.php', { username: v });
                toast('Username updated ✓', 'success', 1800);
                profile.username = v;
                navHandle.textContent = '@' + v;
            } catch (e) {
                toast(e.message || 'Update failed', 'error', 3200);
                saveUsername.disabled = false;
            }
        });

        saveEmail?.addEventListener('click', async () => {
            const v = emailInput.value.trim();
            const pw = currentPw.value;
            if (!pw) { toast('Enter your current password to change email.', 'error', 3200); return; }
            saveEmail.disabled = true;
            try {
                await api('POST', '/users/update.php', { email: v, current_password: pw });
                toast('Email updated. Check your inbox to verify ✓', 'success', 3200);
                profile.email = v;
                currentPw.value = '';
            } catch (e) {
                toast(e.message || 'Update failed', 'error', 3200);
                saveEmail.disabled = false;
            }
        });

        savePassword?.addEventListener('click', async () => {
            const pw = currentPw.value;
            const np = newPw.value;
            try {
                await api('POST', '/users/update.php', {
                    current_password: pw,
                    new_password: np,
                });
                toast('Password changed ✓', 'success', 2200);
                currentPw.value = newPw.value = newPwConfirm.value = '';
                savePassword.disabled = true;
            } catch (e) {
                toast(e.message || 'Update failed', 'error', 3200);
            }
        });
    }

    /* ══════════════════════════════════════════════════════════════════
     * FIELD WIRING
     * ════════════════════════════════════════════════════════════════ */

    function wireFields() {
        // Text/number/textarea/url/email/date inputs — save on blur
        contentEl.querySelectorAll('[data-field]').forEach(el => {
            if (el.type === 'checkbox' || el.tagName === 'SELECT') return;
            if (el.type === 'range') {
                el.addEventListener('input', () => updateRangeCounter(el));
                el.addEventListener('change', () => scheduleSave(el.dataset.field, 100));
                return;
            }
            const key = el.dataset.field;

            // Textarea — save on blur too (cleaner than debounced keystrokes)
            el.addEventListener('blur', () => {
                scheduleSave(key, 150);
            });

            // Live counters
            if (el.tagName === 'TEXTAREA' && key === 'bio') {
                el.addEventListener('input', () => updateCounter('bio', el.value));
            }
        });

        // Checkboxes (has_kids, music_autoplay)
        contentEl.querySelectorAll('input[type="checkbox"][data-field]').forEach(el => {
            el.addEventListener('change', () => scheduleSave(el.dataset.field, 100));
        });

        // Selects
        contentEl.querySelectorAll('select[data-field]').forEach(el => {
            el.addEventListener('change', () => scheduleSave(el.dataset.field, 100));
        });

        // Privacy toggles + visibility
        contentEl.querySelectorAll('[data-toggle]').forEach(el => {
            el.addEventListener('change', () => schedulePrivacyDebounced());
        });
        document.getElementById('edit-visibility-select')?.addEventListener('change', () => {
            schedulePrivacyDebounced();
        });

        // Image pickers
        ['avatar', 'banner', 'wallpaper'].forEach(kind => {
            const input = contentEl.querySelector(`[data-image-input="${kind}"]`);
            if (!input) return;
            input.addEventListener('change', e => {
                const file = e.target.files && e.target.files[0];
                if (file) uploadImage(kind, file);
                e.target.value = ''; // allow re-selecting the same file
            });
        });
    }

    /* Debounced privacy save so rapid toggle flips don't spam the API */
    let privacyTimer = null;
    function schedulePrivacyDebounced() {
        if (privacyTimer) clearTimeout(privacyTimer);
        privacyTimer = setTimeout(savePrivacy, 500);
    }

    function updateCounter(key, value) {
        const el = contentEl.querySelector(`[data-counter="${key}"]`);
        if (el) el.textContent = String(value.length);
    }

    function updateRangeCounter(el) {
        const key = el.dataset.field;
        const counter = contentEl.querySelector(`[data-counter="${key}"]`);
        if (counter) counter.textContent = el.value;
    }

    /* ══════════════════════════════════════════════════════════════════
     * NAVIGATION
     * ════════════════════════════════════════════════════════════════ */

    function buildNav() {
        navListEl.innerHTML = '';
        SECTIONS.forEach((s, i) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'edit-nav__item' + (i === 0 ? ' is-active' : '');
            btn.dataset.section = s.key;
            btn.textContent = s.label;
            btn.addEventListener('click', () => {
                document.querySelectorAll('.edit-nav__item').forEach(b => b.classList.remove('is-active'));
                btn.classList.add('is-active');
                document.querySelectorAll('.edit-section').forEach(sec => {
                    sec.classList.toggle('is-visible', sec.dataset.section === s.key);
                });
                contentEl.scrollTo({ top: 0, behavior: 'smooth' });
            });
            navListEl.appendChild(btn);
        });

        // Show first section
        document.querySelectorAll('.edit-section').forEach((sec, i) => {
            sec.classList.toggle('is-visible', i === 0);
        });
    }

    /* ══════════════════════════════════════════════════════════════════
     * BOOT
     * ════════════════════════════════════════════════════════════════ */

    async function boot() {
        loadingEl.hidden = false;
        errorEl.hidden = true;
        shellEl.hidden = true;

        await fetchCsrf();

        try {
            await loadProfile();
        } catch (e) {
            err('load failed', e);
            loadingEl.hidden = true;
            errorEl.hidden = false;
            errorMsgEl.textContent = e.message || 'Could not reach the API.';
            return;
        }

        buildNav();
        populateForm();
        wireFields();
        wireAccountSection();

        loadingEl.hidden = true;
        shellEl.hidden = false;
    }

    retryBtn.addEventListener('click', boot);

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

    /* Warn on unload if a save is pending */
    window.addEventListener('beforeunload', e => {
        if (dirty.size || saveTimers.size) {
            e.preventDefault();
            e.returnValue = '';
        }
    });

})();