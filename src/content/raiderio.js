// raiderio.js — content script for raider.io

let warcraftLogsRedirected = false;
let filterSettings = { minIlvl: 0, selectedClasses: [], selectedRoles: [], selectedRegions: [] };
let wclSettings = {
    enabled: false,
    minBest: 0, minMedian: 0,
    minBestHealer: 0, minMedianHealer: 0,
    minBestTank: 0, minMedianTank: 0,
    concurrency: 4,
};

function isRaiderIoCharacterPage() {
    return window.location.pathname.includes('/characters/');
}

function isSearchPage() {
    return window.location.href.includes('raider.io/search') &&
           window.location.href.includes('recruitment.guild_raids');
}

function convertRaiderIoToWarcraftLogs(raiderIoUrl) {
    try {
        const url = new URL(raiderIoUrl);
        const parts = url.pathname.split('/');
        if (parts.length < 5 || parts[1] !== 'characters') return null;
        const region    = parts[2].toLowerCase();
        const realm     = parts[3].replace(/\s/g, '-');
        const character = parts[4];
        if (!region || !realm || !character) return null;
        return `https://www.warcraftlogs.com/character/${region}/${realm}/${character}`;
    } catch {
        return null;
    }
}

function enforceSortingAndPublishedColumn() {
    if (!isSearchPage()) return;
    const href   = window.location.href;
    const params = new URLSearchParams(window.location.search);
    const toAppend = [];
    // Without an explicit type, Raider.IO ignores the recruitment.* filters and
    // renders its "Add some filters to find Characters" empty state instead of
    // the recruitment listing. Only fill in a *missing* type — an explicit
    // type=guild/team is the officer browsing the other side of recruitment,
    // and overwriting it would both hijack that page and re-trigger this
    // redirect forever.
    if (!params.has('type')) toAppend.push('type=character');
    if (!params.has('recruitment.guild_raids.profile.published_at[0][gte]'))
        toAppend.push('recruitment.guild_raids.profile.published_at%5B0%5D%5Bgte%5D=1');
    if (!params.has('sort[recruitment.guild_raids.profile.published_at]'))
        toAppend.push('sort%5Brecruitment.guild_raids.profile.published_at%5D=desc');
    if (toAppend.length > 0)
        window.location.replace(href + (href.includes('?') ? '&' : '?') + toAppend.join('&'));
}

function handleWarcraftLogsRedirection(enabled) {
    if (!enabled || warcraftLogsRedirected) return;
    if (isRaiderIoCharacterPage()) {
        setTimeout(() => {
            if (warcraftLogsRedirected) return;
            const url = convertRaiderIoToWarcraftLogs(window.location.href);
            if (url) { sendMessageToBackground('openTab', { url }); warcraftLogsRedirected = true; }
        }, 500);
    }
}

function hideAds() {
    const style = document.createElement('style');
    style.textContent = `
        .advertisement, .ad-container, [data-gg-ad], [id^="div-gpt-ad"],
        [class*="advertisement"], iframe[src*="doubleclick.net"],
        iframe[src*="googlesyndication.com"] { display: none !important; }
    `;
    document.head.appendChild(style);
}

// The results table's cells (.rt-td) come with `overflow: hidden;
// white-space: nowrap` from react-table, so a badge appended after the
// character name gets hard-clipped at the cell edge once the row is full.
// Shrinking the badge to fit the cell's typical free space and falling back
// to `overflow: visible` (rather than growing the row — the table is
// virtualized and relies on a fixed row height, so resizing rows would
// misalign them) keeps the parse text fully readable without touching the
// table's own layout.
const RIO_BADGE_CSS_ID = 'raidscout-rio-badge-styles';
function ensureRioBadgeStyles() {
    if (document.getElementById(RIO_BADGE_CSS_ID)) return;
    const style = document.createElement('style');
    style.id = RIO_BADGE_CSS_ID;
    style.textContent = `
        .rt-tr-group .rt-td:first-child {
            overflow: visible !important;
        }
        .rt-tr-group .rs-badge {
            font-size: 9px;
            padding: 1px 4px;
            gap: 2px;
            margin-left: 4px;
        }
    `;
    (document.head || document.documentElement).appendChild(style);
}

// ─── Row data extraction ───────────────────────────────────────────────────────

function getRowData(row) {
    const cells = row.querySelectorAll('.rt-td');
    if (cells.length < 6) return null;
    const playerClass = normalizeClassName(cells[1]?.querySelector('.slds-avatar[title]')?.title ?? null);
    const realmText   = cells[2]?.querySelector('.rio-realm-link')?.textContent ?? '';
    const region      = realmText.match(/^\(([A-Z]+)\)/)?.[1] ?? null;
    const ilvlText    = cells[4]?.querySelector('.slds-text-align--center')?.textContent.trim() ?? '';
    const ilvl        = parseFloat(ilvlText);
    // The search table has no role column — cells[5] is "Published". The class
    // cell carries two avatars, class then spec, and the spec is the only role
    // signal on the page.
    const specTitle = cells[1]?.querySelectorAll('.slds-avatar[title]')[1]?.title ?? null;
    const role      = specToRole(specTitle);
    return { playerClass, region, ilvl: isNaN(ilvl) ? null : ilvl, role };
}

function getRowCharacter(group) {
    const link = group.querySelector('a[href*="/characters/"]');
    if (!link) return null;
    const parts = link.getAttribute('href').split('?')[0].split('/').filter(Boolean);
    const idx = parts.indexOf('characters');
    if (idx === -1 || parts.length < idx + 4) return null;
    // Also extract role for metric selection
    const row  = group.querySelector('.rt-tr');
    const data = row ? getRowData(row) : null;
    return {
        region: parts[idx + 1].toLowerCase(),
        realm:  parts[idx + 2].replace(/\s/g, '-').toLowerCase(),
        name:   decodeURIComponent(parts[idx + 3]),
        role:   data?.role || 'dps',
    };
}

// ─── Row filtering ─────────────────────────────────────────────────────────────

function filterSearchRows() {
    if (!isSearchPage()) return;
    const { minIlvl, selectedClasses, selectedRoles, selectedRegions } = filterSettings;

    for (const group of document.querySelectorAll('.rt-tr-group')) {
        // WCL-hidden rows stay hidden regardless of standard filters
        if (group.dataset.wclHidden === 'true') { group.style.display = 'none'; continue; }

        const row = group.querySelector('.rt-tr');
        if (!row) continue;
        const data = getRowData(row);
        if (!data) continue;

        const visible =
            (minIlvl === 0          || data.ilvl === null        || data.ilvl >= minIlvl) &&
            (selectedClasses.length === 0 || data.playerClass === null || selectedClasses.includes(data.playerClass)) &&
            (selectedRoles.length   === 0 || data.role === null        || selectedRoles.includes(data.role)) &&
            (selectedRegions.length === 0 || data.region === null      || selectedRegions.includes(data.region));

        group.style.display = visible ? '' : 'none';
    }

    if (wclSettings.enabled) applyWclScoring();
}

// ─── WCL scoring ──────────────────────────────────────────────────────────────

let wclHiddenCount = 0;
let wclTotalCount  = 0;

async function applyWclScoring() {
    const groups = Array.from(document.querySelectorAll('.rt-tr-group'))
        .filter(g => g.style.display !== 'none' && !g.dataset.wclScored);

    if (groups.length === 0) return;

    ensureRioBadgeStyles();

    // Show pending badges
    for (const group of groups) {
        const nameCell = group.querySelector('.rt-td:first-child');
        if (nameCell) setBadgeState(nameCell, 'pending', null, wclSettings);
    }

    wclTotalCount  = document.querySelectorAll('.rt-tr-group').length;
    wclHiddenCount = document.querySelectorAll('.rt-tr-group[data-wcl-hidden="true"]').length;
    const summaryAnchor = assertSelector('.rt-tbody', document, 'Raider.IO results body');
    upsertFilterSummary(summaryAnchor, wclHiddenCount, wclTotalCount);

    await runWithConcurrency(groups, async (group) => {
        group.dataset.wclScored = 'pending';
        const character = getRowCharacter(group);
        const nameCell  = group.querySelector('.rt-td:first-child');

        if (!character) {
            group.dataset.wclScored = 'done';
            return;
        }

        const score = await requestWclScore(character);
        group.dataset.wclScored = 'done';
        if (score.best   !== null && score.best   !== undefined) group.dataset.wclBest   = String(score.best);
        if (score.median !== null && score.median !== undefined) group.dataset.wclMedian = String(score.median);

        let badgeState = 'score';
        if (score.error && score.rateLimitMs)                                   badgeState = 'rate-limited';
        else if (score.error)                                                    badgeState = 'error';
        else if (score.notFound || (score.best === null && score.median === null)) badgeState = 'no-logs';

        if (nameCell) setBadgeState(nameCell, badgeState, score, wclSettings, character.role);

        if (failsWclThresholds(score, wclSettings, character.role)) {
            group.dataset.wclHidden = 'true';
            group.style.display = 'none';
            wclHiddenCount++;
        }
        upsertFilterSummary(summaryAnchor, wclHiddenCount, wclTotalCount);
    }, wclSettings.concurrency || 4);

    if (wclSettings.sort) {
        const visibleGroups = Array.from(document.querySelectorAll('.rt-tr-group')).filter(g => g.style.display !== 'none');
        sortByWclScore(visibleGroups);
    }
}

// ─── Live settings re-evaluation ──────────────────────────────────────────────

const RIO_WCL_KEYS = ['rioWclEnabled', ...SHARED_WCL_KEYS];

watchSettings(RIO_WCL_KEYS, () => {
    const allGroups = Array.from(document.querySelectorAll('.rt-tr-group'));
    clearWclMarkers(allGroups);
    wclHiddenCount = 0;

    // Re-read all WCL settings from storage so no key is missed
    chrome.storage.sync.get(RIO_WCL_KEYS, (options) => {
        wclSettings = { enabled: !!options.rioWclEnabled, sort: wclSortEnabled(options), ...buildWclSettings(options) };
        filterSearchRows();
    });
});

// ─── Observer + init ─────────────────────────────────────────────────────────

let observerTimer = null;
function observePageChanges(wclEnabled) {
    const observer = new MutationObserver(() => {
        clearTimeout(observerTimer);
        observerTimer = setTimeout(() => {
            enforceSortingAndPublishedColumn();
            handleWarcraftLogsRedirection(wclEnabled);
            filterSearchRows();
        }, 250);
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

chrome.storage.sync.get([
    'raiderioEnabled', 'openWarcraftLogsFromRaiderIO', 'hideRaiderIoAds',
    'rioMinIlvl', 'rioSelectedClasses', 'rioSelectedRoles', 'rioSelectedRegions',
    'rioWclEnabled', ...SHARED_WCL_KEYS,
], function(options) {
    if (options.raiderioEnabled === false) return;

    const wclEnabled = options.openWarcraftLogsFromRaiderIO !== false;
    filterSettings = {
        minIlvl:         parseFloat(options.rioMinIlvl) || 0,
        selectedClasses: options.rioSelectedClasses  || [],
        selectedRoles:   options.rioSelectedRoles    || [],
        selectedRegions: options.rioSelectedRegions  || [],
    };
    wclSettings = { enabled: !!options.rioWclEnabled, sort: wclSortEnabled(options), ...buildWclSettings(options) };

    enforceSortingAndPublishedColumn();
    observePageChanges(wclEnabled);
    handleWarcraftLogsRedirection(wclEnabled);
    filterSearchRows();

    if (options.hideRaiderIoAds) hideAds();
});

// ─── Scout harvest ─────────────────────────────────────────────────────────────
// Raider.IO renders its recruitment table client-side, so Scout cannot fetch and
// parse it — it opens this page in a background tab and collects the rows that
// survive filterSearchRows() here instead.

registerHarvester('raiderio', '.rt-tr-group', function () {
    return Array.from(document.querySelectorAll('.rt-tr-group'))
        .filter(group => group.style.display !== 'none' && group.dataset.wclHidden !== 'true')
        .map(group => {
            const character = getRowCharacter(group);
            if (!character) return null;
            const row  = group.querySelector('.rt-tr');
            const data = row ? getRowData(row) : null;
            const href = group.querySelector('a[href*="/characters/"]')?.getAttribute('href');
            return {
                ...character,
                role:        data?.role ?? null,
                playerClass: data?.playerClass ?? null,
                ilvl:        data?.ilvl ?? null,
                link:        href ? new URL(href, 'https://raider.io').toString() : null,
            };
        })
        .filter(Boolean);
});
