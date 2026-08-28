// options.js — Full Settings page
// Uses settings-schema.js (injected before this file) for load/save.

document.addEventListener('DOMContentLoaded', function () {

    // ── Tab navigation ────────────────────────────────────────────────────────
    const tabBtns    = document.querySelectorAll('.tab-btn');
    const categories = document.querySelectorAll('.category-content');

    function showCategory(cat) {
        categories.forEach(c => c.style.display = 'none');
        document.getElementById(cat).style.display = 'block';
        tabBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.tab === cat));
    }

    const savedCategory = localStorage.getItem('selectedCategory') || 'warcraftlogs';
    showCategory(savedCategory);
    tabBtns.forEach(btn => btn.addEventListener('click', function () {
        localStorage.setItem('selectedCategory', this.dataset.tab);
        showCategory(this.dataset.tab);
    }));

    // ── Per-site enable toggles ───────────────────────────────────────────────
    // Turning a site off greys out its settings (`.section-disabled` in
    // options.css) and disables the controls, so it's obvious they aren't in
    // effect. The enable toggle itself lives in `.section-header`, outside the
    // `.option` blocks this disables, so it stays clickable.
    const SITE_SECTIONS = ['warcraftlogs', 'wowprogress', 'raiderio', 'guildsofwow'];
    const SECTION_CONTROLS = '.option input, .option select, .option button, '
                           + '.option-group input, .option-group select, .option-group button';

    function syncSectionEnabledState(sectionId) {
        const section = document.getElementById(sectionId);
        const toggle  = document.getElementById(sectionId + 'Enabled');
        if (!section || !toggle) return;
        const enabled = toggle.checked;
        section.classList.toggle('section-disabled', !enabled);
        section.querySelectorAll(SECTION_CONTROLS).forEach(el => { el.disabled = !enabled; });
    }

    for (const sectionId of SITE_SECTIONS) {
        document.getElementById(sectionId + 'Enabled')
            ?.addEventListener('change', () => syncSectionEnabledState(sectionId));
    }

    // ── Load settings ─────────────────────────────────────────────────────────
    chrome.storage.sync.get(ALL_KEYS, function (data) {
        loadFromData(data);
        SITE_SECTIONS.forEach(syncSectionEnabledState);

        // Secret is local-only — read separately
        chrome.storage.local.get('wclClientSecret', function (local) {
            document.getElementById('wclClientSecret').value = local.wclClientSecret || '';
        });
        // Debug flag is also local
        chrome.storage.local.get('wclDebug', function (local) {
            document.getElementById('wclDebug').checked = !!local.wclDebug;
        });

        // API backoff status (rate limit or Cloudflare) — counts down, clears at zero
        chrome.runtime.sendMessage({ action: 'getApiStatus' }, function (status) {
            if (status && status.state !== 'ok') {
                startBackoffCountdown(status.state, status.remainingMs);
            }
        });
    });

    // ── Checkbox group clear buttons ──────────────────────────────────────────
    const clearMap = {
        clearWclClasses:  '.wclClassFilter',
        clearClasses:     '.classFilter',
        clearGowClasses:  '.gowClassFilter',
        clearRioClasses:  '.rioClassFilter',
    };
    for (const [id, sel] of Object.entries(clearMap)) {
        const btn = document.getElementById(id);
        if (btn) btn.addEventListener('click', () =>
            document.querySelectorAll(sel).forEach(cb => cb.checked = false));
    }

    // ── Clear cache ───────────────────────────────────────────────────────────
    document.getElementById('clearWclScoreCache').addEventListener('click', function () {
        chrome.runtime.sendMessage({ action: 'clearWclScoreCache' }, function () {
            showStatus('✓ Cached scores cleared', 2000);
        });
    });

    // ── Test credentials ──────────────────────────────────────────────────────
    document.getElementById('testWclCredentials').addEventListener('click', function () {
        const btn      = this;
        const statusEl = document.getElementById('wclTestStatus');
        btn.disabled   = true;
        statusEl.textContent = 'Testing…';
        statusEl.style.color = '#aaa';

        const secret = document.getElementById('wclClientSecret').value.trim();
        chrome.runtime.sendMessage({ action: 'storeWclSecret', secret }, function () {
            chrome.runtime.sendMessage({ action: 'testWclCredentials' }, function (result) {
                btn.disabled = false;
                if (result?.ok) {
                    statusEl.style.color = '#4caf50';
                    statusEl.textContent = '✓ Connected successfully';
                } else {
                    statusEl.style.color = '#f04040';
                    statusEl.textContent = '✗ ' + (result?.error || 'Connection failed');
                }
            });
        });
    });

    // ── Export / Import ───────────────────────────────────────────────────────
    document.getElementById('exportSettings').addEventListener('click', function () {
        chrome.storage.sync.get(null, function (syncData) {
            // Include local-only settings as a clearly-labelled sub-object
            chrome.storage.local.get(['wclDebug', 'wclCacheTtlHours'], function (localData) {
                const exportData = {
                    _version: 2,
                    _note: 'wclClientSecret is machine-local and is not exported.',
                    sync: syncData,
                    localSettings: localData,
                };
                const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
                const url  = URL.createObjectURL(blob);
                const a    = document.createElement('a');
                a.href     = url;
                a.download = 'raidscout-settings.json';
                a.click();
                URL.revokeObjectURL(url);
            });
        });
    });

    const importFile = document.getElementById('importFile');
    document.getElementById('importSettings').addEventListener('click', () => importFile.click());
    importFile.addEventListener('change', function () {
        const file = this.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function (e) {
            try {
                const raw = JSON.parse(e.target.result);
                // Support both v1 (flat) and v2 (nested) export formats
                const syncData  = raw._version === 2 ? raw.sync        : raw;
                const localData = raw._version === 2 ? raw.localSettings : {};

                chrome.storage.sync.set(syncData, function () {
                    if (localData && Object.keys(localData).length) {
                        chrome.storage.local.set(localData);
                    }
                    showStatus('✓ Settings imported', 2000);
                    setTimeout(() => location.reload(), 400);
                });
            } catch {
                showStatus('✗ Invalid settings file', 3000);
            }
        };
        reader.readAsText(file);
        this.value = '';
    });

    // ── Save ──────────────────────────────────────────────────────────────────
    document.getElementById('saveButton').addEventListener('click', function () {
        const toSync = collectFromDom();
        chrome.storage.sync.set(toSync, function () {
            // Secret and debug flag go to local storage
            const secret = document.getElementById('wclClientSecret').value.trim();
            chrome.runtime.sendMessage({ action: 'storeWclSecret', secret }, function () {
                chrome.storage.local.set({ wclDebug: document.getElementById('wclDebug').checked });
            });
            showStatus('✓ Settings saved', 2000);
        });
    });

    // ── Helpers ───────────────────────────────────────────────────────────────
    function showStatus(msg, ms) {
        const el = document.getElementById('statusMessage');
        el.textContent = msg;
        setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, ms);
    }

    let backoffTimer = null;
    function startBackoffCountdown(state, remainingMs) {
        const el   = document.getElementById('wclRateLimitStatus');
        const hint = document.getElementById('wclCloudflareHint');
        const label = state === 'cloudflare' ? '☁ Cloudflare check' : '⚠ Rate limited';
        clearInterval(backoffTimer);
        if (hint) hint.style.display = state === 'cloudflare' ? '' : 'none';

        let secs = Math.ceil(remainingMs / 1000);
        const render = () => { el.textContent = `${label} — retry in ${secs}s`; };
        render();
        backoffTimer = setInterval(() => {
            secs--;
            if (secs <= 0) {
                clearInterval(backoffTimer);
                el.textContent = '';
                if (hint) hint.style.display = 'none';
                return;
            }
            render();
        }, 1000);
    }
});
