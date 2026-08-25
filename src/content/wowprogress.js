// wowprogress.js — content script for wowprogress.com

function getPlayerClass(playerRow) {
    const characterEl = playerRow.querySelector('.character');
    if (!characterEl) return null;
    for (const cls of characterEl.classList) {
        if (WOW_CLASS_NAMES.includes(cls)) return cls;
    }
    for (const cls of playerRow.classList) {
        if (WOW_CLASS_NAMES.includes(cls)) return cls;
    }
    return null;
}

// WoWProgress shows role via a class icon — attempt to derive from spec icon name
// in the character link tooltip or title. Falls back to null (treated as DPS).
function getPlayerRole(playerRow) {
    const icon = playerRow.querySelector('img[src*="spec_icon"], img[alt*="Healer"], img[alt*="Tank"]');
    if (!icon) return null;
    const alt = (icon.alt || '').toLowerCase();
    if (alt.includes('heal')) return 'healer';
    if (alt.includes('tank')) return 'tank';
    return 'dps';
}

function filterPlayers(selectedRegions, minIlvl, maxIlvl, selectedClasses, guildFilter) {
    const rows = assertSelector('.rating', document, 'WoWProgress rating table')
        ? document.querySelectorAll('.rating tr')
        : [];

    let hiddenCount = 0;
    const allRows = Array.from(rows).slice(1);

    for (const playerRow of allRows) {
        const realmElement = playerRow.querySelector('.realm');
        const ilvlElement  = playerRow.querySelector('td.center');
        const playerIlvl   = ilvlElement ? parseFloat(ilvlElement.textContent.trim()) : null;
        const playerClass  = getPlayerClass(playerRow);
        const inGuild      = playerRow.querySelector('.guild') !== null;

        const regionMatch = !realmElement ? false :
            selectedRegions.length === 0 || selectedRegions.some(r => realmElement.textContent.includes(r));
        const ilvlMatch = playerIlvl === null ||
            (playerIlvl >= minIlvl && (maxIlvl === 0 || playerIlvl <= maxIlvl));
        const classMatch = selectedClasses.length === 0 || playerClass === null || selectedClasses.includes(playerClass);
        const guildMatch = guildFilter === 'any' || (guildFilter === 'in' && inGuild) || (guildFilter === 'out' && !inGuild);

        if (!(regionMatch && ilvlMatch && classMatch && guildMatch)) {
            playerRow.remove();
            hiddenCount++;
        }
    }
}

// ─── WCL identity extraction ───────────────────────────────────────────────────

function getWowProgressCharacter(playerRow) {
    const link = playerRow.querySelector('a[href*="/character/"]');
    if (!link) return null;
    const parts = link.getAttribute('href').split('/').filter(Boolean);
    const idx = parts.indexOf('character');
    if (idx === -1 || parts.length < idx + 4) return null;
    const role = getPlayerRole(playerRow);
    // WoWProgress percent-encodes spaces in realm names ("Tarren%20Mill"), so
    // the realm must be decoded before slugging — otherwise the WCL API is
    // queried for "tarren%20mill" and returns notFound for every multi-word realm.
    let realm = parts[idx + 2];
    try { realm = decodeURIComponent(realm); } catch { /* keep raw */ }

    return {
        region: parts[idx + 1].toLowerCase(),
        realm:  realm.replace(/\s/g, '-').toLowerCase(),
        name:   decodeURIComponent(parts[idx + 3].split('?')[0]),
        role:   role || 'dps',
    };
}

// ─── WCL scoring ──────────────────────────────────────────────────────────────
// WoWProgress: we HIDE scored rows (not remove) so they can be revealed if
// WCL settings change later in the session. The original standard-filter pass
// removes rows that fail non-WCL criteria; WCL-scored rows that fail are hidden.

let wclThresholds = { minBest: 0, minMedian: 0 };
let wclSummaryAnchor = null;

async function applyWclScoring(wclSettings) {
    wclThresholds = wclSettings;
    const rows = Array.from(document.querySelectorAll('.rating tr'))
        .slice(1)
        .filter(row => row.isConnected && !row.dataset.wclScored);

    if (rows.length === 0) return;

    for (const row of rows) {
        const nameCell = row.querySelector('.character');
        if (nameCell) setBadgeState(nameCell, 'pending', null, wclThresholds, null);
    }

    let hiddenByWcl = document.querySelectorAll('.rating tr[data-wcl-hidden="true"]').length;
    const totalScored = rows.length + hiddenByWcl;
    // Re-resolve the anchor each page: WoWProgress paginates by swapping the
    // table inside .ratingContainer, so a cached anchor becomes detached and
    // upsertFilterSummary would throw on its null parentNode.
    if (!wclSummaryAnchor || !wclSummaryAnchor.isConnected) {
        wclSummaryAnchor = document.querySelector('.rating');
    }
    upsertFilterSummary(wclSummaryAnchor, hiddenByWcl, totalScored);

    await runWithConcurrency(rows, async (row) => {
        row.dataset.wclScored = 'pending';
        const character = getWowProgressCharacter(row);
        const nameCell  = row.querySelector('.character');

        if (!character) {
            row.dataset.wclScored = 'done';
            if (nameCell) setBadgeState(nameCell, 'error', { error: 'Could not read character link' }, wclThresholds, null);
            return;
        }

        const score = await requestWclScore(character);
        row.dataset.wclScored = 'done';
        if (!row.isConnected) return;
        if (score.best   !== null && score.best   !== undefined) row.dataset.wclBest   = String(score.best);
        if (score.median !== null && score.median !== undefined) row.dataset.wclMedian = String(score.median);

        let badgeState = 'score';
        if (score.error && score.rateLimitMs) badgeState = 'rate-limited';
        else if (score.error)                 badgeState = 'error';
        else if (score.notFound || (score.best === null && score.median === null)) badgeState = 'no-logs';

        if (nameCell) setBadgeState(nameCell, badgeState, score, wclThresholds, character.role);

        if (failsWclThresholds(score, wclThresholds, character.role)) {
            row.dataset.wclHidden = 'true';
            row.style.display = 'none';
            hiddenByWcl++;
        }
        upsertFilterSummary(wclSummaryAnchor, hiddenByWcl, totalScored);
    }, wclSettings.concurrency || 4);

    if (wclSettings.sort) {
        const visibleRows = Array.from(document.querySelectorAll('.rating tr'))
            .slice(1)
            .filter(row => row.isConnected && row.style.display !== 'none');
        sortByWclScore(visibleRows);
    }
}

// ─── Live settings re-evaluation ──────────────────────────────────────────────

const WP_WCL_KEYS = ['wpWclEnabled', ...SHARED_WCL_KEYS];

watchSettings(WP_WCL_KEYS, () => {
    // Clear all WCL markers so the next filter pass re-scores everything
    const rows = document.querySelectorAll('.rating tr[data-wcl-scored]');
    clearWclMarkers(Array.from(rows));
    loadSettingsAndFilter();
});

// ─── Main filter pass ─────────────────────────────────────────────────────────

function loadSettingsAndFilter() {
    chrome.storage.sync.get([
        'selectedRegions', 'region', 'minIlvl', 'maxIlvl', 'selectedClasses', 'guildFilter',
        'wpWclEnabled', ...SHARED_WCL_KEYS,
    ], function(options) {
        const selectedRegions = options.selectedRegions ?? (options.region ? [options.region] : ['EU']);
        const minIlvl         = parseFloat(options.minIlvl) || 0;
        const maxIlvl         = parseFloat(options.maxIlvl) || 0;
        const selectedClasses = options.selectedClasses || [];
        const guildFilter     = options.guildFilter || 'any';
        filterPlayers(selectedRegions, minIlvl, maxIlvl, selectedClasses, guildFilter);

        if (options.wpWclEnabled) {
            applyWclScoring({ ...buildWclSettings(options), sort: wclSortEnabled(options) });
        }
    });
}

function observeTableChanges() {
    const tableContainer = assertSelector('.ratingContainer', document, 'WoWProgress ratingContainer');
    if (!tableContainer) return;

    const observer = new MutationObserver(mutations => {
        if (mutations.some(m => m.type === 'childList')) loadSettingsAndFilter();
    });
    observer.observe(tableContainer, { childList: true, subtree: true });
    loadSettingsAndFilter();
}

function handlePageNavigation() {
    setInterval(() => {
        const table = document.querySelector('.ratingContainer table');
        if (table && !table.dataset.filtered) {
            table.dataset.filtered = 'true';
            observeTableChanges();
        }
    }, 2000);
}

function hasRequiredParameters() {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.has('lang') && urlParams.has('raids_week');
}

function appendRequiredParameters(url) {
    const urlParams = new URLSearchParams(url.search);
    urlParams.set('lang', 'en');
    urlParams.set('raids_week', '2');
    urlParams.set('sortby', 'ts');
    return `${url.pathname}?${urlParams.toString()}`;
}

function redirectRealmPageIfNeeded() {
    const url = new URL(window.location.href);
    if (url.pathname.includes('/gearscore/') && url.search.includes('lfg=1')) {
        if (!hasRequiredParameters()) {
            window.location.href = appendRequiredParameters(url);
        }
    }
}

function isTargetPage() {
    const segments = new URL(window.location.href).pathname.split('/');
    return segments.length === 3 && segments[1] === 'gearscore';
}

chrome.storage.sync.get('wowprogressEnabled', function(options) {
    if (options.wowprogressEnabled !== false) {
        redirectRealmPageIfNeeded();
        if (isTargetPage()) {
            observeTableChanges();
            handlePageNavigation();
        }
    }
});

// ─── Scout harvest ─────────────────────────────────────────────────────────────
// Returns the rows still standing after filterPlayers()/applyWclScoring() have
// run. Registered unconditionally so Scout works even when the WoWProgress
// integration toggle is off (Scout warns the officer that filters didn't run).

registerHarvester('wowprogress', '.rating tr', function () {
    return Array.from(document.querySelectorAll('.rating tr'))
        .slice(1)
        .filter(row => row.isConnected && row.style.display !== 'none' && row.dataset.wclHidden !== 'true')
        .map(row => {
            const character = getWowProgressCharacter(row);
            if (!character) return null;
            const ilvlText = row.querySelector('td.center')?.textContent?.trim() ?? '';
            const link = row.querySelector('a[href*="/character/"]')?.getAttribute('href');
            return {
                ...character,
                playerClass: getPlayerClass(row),
                role:        getPlayerRole(row),
                ilvl:        parseFloat(ilvlText),
                inGuild:     row.querySelector('.guild') !== null,
                link:        link ? `https://www.wowprogress.com${link}` : null,
            };
        })
        .filter(Boolean);
});
