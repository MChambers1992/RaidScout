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
    // Raider.IO's advanced search returns nothing at all without type=character —
    // the table renders with an empty `.rt-noData` body rather than an error — so
    // this is as load-bearing as the recruitment filter itself.
    if (!params.has('type'))
        toAppend.push('type=character');
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
            if (!url) return;
            warcraftLogsRedirected = true;
            // The background pre-flights the parse check and may decide this
            // character isn't worth a tab. Nothing opening is the *point*, so
            // say why rather than looking like the feature broke.
            sendMessageToBackground('openTab', { url }, response => {
                if (response && response.opened === false && response.verdict === 'reject') {
                    showScoutSkipNotice(response.score);
                }
            });
        }, 500);
    }
}

// Small transient banner explaining a skipped WarcraftLogs tab.
const RIO_NOTICE_ID = 'raidscout-scout-notice';
function showScoutSkipNotice(score) {
    document.getElementById(RIO_NOTICE_ID)?.remove();

    const fmt = v => (typeof v === 'number' ? Math.round(v) + '%' : '?');
    const el = document.createElement('div');
    el.id = RIO_NOTICE_ID;
    el.textContent = `RaidScout: skipped WarcraftLogs — ${fmt(score?.best)} best / ${fmt(score?.median)} median is below your thresholds`;
    el.style.cssText = [
        'position:fixed', 'bottom:16px', 'right:16px', 'z-index:2147483647',
        'background:#2d0000', 'color:#f0a0a0', 'border:1px solid #7a0000',
        'border-radius:4px', 'padding:8px 12px', 'font-size:12px', 'font-weight:600',
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
        'box-shadow:0 2px 8px rgba(0,0,0,.4)',
    ].join(';');
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 6000);
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

// The class cell carries two avatars: the class, then the spec — e.g.
// title="Shaman" followed by title="Restoration", backed by a
// `spec_<class>_<spec>` class on the sprite. Both are present on every row.
function getRowSpec(classCell) {
    if (!classCell) return null;
    const avatars = classCell.querySelectorAll('.slds-avatar[title]');
    // [0] is the class, [1] is the spec. Read the title rather than the sprite
    // class because the title is the spec's display name, which is what
    // roleForSpec() matches on.
    if (avatars.length > 1 && avatars[1].title) return avatars[1].title;

    // Fallback for a row that renders the sprite without a title: the class name
    // is on the sprite as `spec_death-knight_blood`, whose last segment is the
    // spec with hyphens for spaces ("beast-mastery").
    const sprite = classCell.querySelector('[class*="spec_"]');
    const match  = String(sprite?.className || '').match(/spec_[a-z-]+_([a-z-]+)/);
    return match ? match[1].replace(/-/g, ' ') : null;
}

function getRowData(row) {
    const cells = row.querySelectorAll('.rt-td');
    if (cells.length < 6) return null;
    const playerClass = normalizeClassName(cells[1]?.querySelector('.slds-avatar[title]')?.title ?? null);
    const realmText   = cells[2]?.querySelector('.rio-realm-link')?.textContent ?? '';
    const region      = realmText.match(/^\(([A-Z]+)\)/)?.[1] ?? null;
    const ilvlText    = cells[4]?.querySelector('.slds-text-align--center')?.textContent.trim() ?? '';
    const ilvl        = parseFloat(ilvlText);

    // Raider.IO removed its role column — the last cell is now "Published", and
    // the .tank-lfg-rio / .healer-lfg-rio / .dps-lfg-rio markers this used to
    // read no longer exist anywhere on the page, so every row parsed as an
    // unknown role. The spec icon replaced it and is on every row, and a spec
    // names its role outright, so this is a better reading than the one it
    // replaces rather than a workaround for it.
    const spec = getRowSpec(cells[1]);
    const role = roleForSpec(spec);

    return { playerClass, region, ilvl: isNaN(ilvl) ? null : ilvl, role, spec };
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
        // 'auto' when this row's role cell didn't parse — see guildsofwow.js
        role:   data?.role || 'auto',
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

        const badgeState = badgeStateForScore(score);
        const role       = effectiveRole(score, character.role);

        if (nameCell) setBadgeState(nameCell, badgeState, score, wclSettings, role);

        if (failsWclThresholds(score, wclSettings, role)) {
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
                spec:        data?.spec ?? null,
                playerClass: data?.playerClass ?? null,
                ilvl:        data?.ilvl ?? null,
                link:        href ? new URL(href, 'https://raider.io').toString() : null,
            };
        })
        .filter(Boolean);
});
