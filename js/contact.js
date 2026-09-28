/* ============================================================================
 * ███ CONTACT.JS ███
 * MyCitadel — Contact Form Enhancements
 * ----------------------------------------------------------------------------
 * • Blocks paste/copy on the verification phrase field
 * • Warns on paste attempts
 * • Client-side sanity checks (server is authoritative)
 * ========================================================================== */
(function () {
    'use strict';

    const form = document.getElementById('contact-form');
    if (!form) return;

    const phraseInput = document.getElementById('phrase');

    if (phraseInput) {
        // Block every route to inject text without typing
        ['paste', 'copy', 'cut', 'drop', 'dragover'].forEach(function (evt) {
            phraseInput.addEventListener(evt, function (e) {
                e.preventDefault();
                showPhraseWarning('Manual typing only — copy and paste is disabled here.');
                return false;
            });
        });

        // Block Ctrl+V / Cmd+V / Shift+Insert explicitly (belt & suspenders)
        phraseInput.addEventListener('keydown', function (e) {
            const isPaste =
                ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') ||
                (e.shiftKey && e.key === 'Insert');
            if (isPaste) {
                e.preventDefault();
                showPhraseWarning('Manual typing only — please type the phrase.');
                return false;
            }
        });

        // Block right-click context menu (removes "Paste" from menu)
        phraseInput.addEventListener('contextmenu', function (e) {
            e.preventDefault();
        });

        // Live feedback as they type
        phraseInput.addEventListener('input', function () {
            const target = phraseInput.dataset.verify || '';
            const value  = phraseInput.value;
            if (value === '') {
                phraseInput.classList.remove('is-match', 'is-mismatch');
                return;
            }
            if (value.toLowerCase() === target.toLowerCase()) {
                phraseInput.classList.add('is-match');
                phraseInput.classList.remove('is-mismatch');
            } else {
                phraseInput.classList.add('is-mismatch');
                phraseInput.classList.remove('is-match');
            }
        });
    }

    function showPhraseWarning(message) {
        let warn = document.getElementById('phrase-warning');
        if (!warn) {
            warn = document.createElement('div');
            warn.id = 'phrase-warning';
            warn.className = 'citadel-msg error';
            warn.style.marginTop = '0.5rem';
            phraseInput.parentNode.appendChild(warn);
        }
        warn.textContent = message;
        warn.style.display = 'block';
        clearTimeout(warn._t);
        warn._t = setTimeout(function () { warn.style.display = 'none'; }, 3200);
    }

    // Client-side form check — server still validates everything
    form.addEventListener('submit', function (e) {
        const phraseInput = document.getElementById('phrase');
        const target = (phraseInput?.dataset.verify || '').toLowerCase();
        const value  = (phraseInput?.value || '').trim().toLowerCase();

        if (target && value !== target) {
            e.preventDefault();
            showPhraseWarning('The verification phrase does not match.');
            phraseInput?.focus();
            return false;
        }
    });

})();