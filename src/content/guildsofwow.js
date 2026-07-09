// guildsofwow.js — content script for guildsofwow.com

function getCardClass(card) {
    const classIcon = card.querySelector('img[src*="class-icons"]');
    return normalizeClassName(classIcon?.alt ?? null);
}

function getCardRole(card) {
    const roleIcon = card.querySelector('img.role-icon[src]');
    if (!roleIcon) return null;
    const match = roleIcon.src.match(/raider-role-(\d+)/);
    if (!match) return null;
    return { '1': 'tank', '2': 'healer', '3': 'dps' }[match[1]] ?? null;
}

function getCardIlvl(card) {
    for (const fieldset of card.querySelectorAll('fieldset')) {
        if (fieldset.querySelector('legend')?.textContent.includes('Item Level')) {
            const text = fieldset.querySelector('.main-stat')?.textContent.trim() ?? '';
            const val = parseFloat(text.split('/')[0]);
            return isNaN(val) ? null : val;
        }
    }
    return null;
}

function getCardMythicKills(card) {
    for (const fieldset of card.querySelectorAll('fieldset')) {
        if (fieldset.querySelector('legend')?.textContent.includes('Raid Progress')) {
            const text = fieldset.querySelector('.main-stat span')?.textContent.trim() ?? '';
            const mythic = text.match(/^(\d+)\/\d+\s*M/);
            if (mythic) return parseInt(mythic[1]);
            // GoW shows only the highest difficulty reached (e.g. "7/9 H").
            // Any progress that isn't Mythic means zero Mythic kills — not
            // "unknown" — so a min-Mythic-kills filter excludes Heroic-only
            // raiders instead of letting them pass on a null.
            if (/^\d+\/\d+/.test(text)) return 0;
            return null;
        }
    }
    return null;
}

function getCardMythicPlusScore(card) {
    for (const fieldset of card.querySelectorAll('fieldset')) {
        if (fieldset.querySelector('legend')?.textContent.includes('M+')) {
            const text = fieldset.querySelector('.main-stat span')?.textContent.trim() ?? '';
            const val = parseInt(text);
            return isNaN(val) ? null : val;
        }
    }
    return null;
}

function getCardCharacter(card) {
    // GoW recruit cards have no character-page link. Identity is recovered from
    // the Blizzard avatar render URL, which encodes region + realm slug:
    //   https://render.worldofwarcraft.com/{region}/character/{realm}/…
    // The character name comes from the avatar alt (falling back to the title).
    const name = (card.querySelector('.card-icon img')?.getAttribute('alt')
        || card.querySelector('.card-title nhea-selectlist button')?.textContent
        || '').trim();
    if (!name) return null;

    const role = getCardRole(card) || 'dps';

    const renderSrc = card.querySelector('.card-icon img[src*="render.worldofwarcraft.com"]')?.getAttribute('src') || '';
    const rm = renderSrc.match(/render\.worldofwarcraft\.com\/([a-z]+)\/character\/([^/?]+)/i);
    if (rm) {
        return { region: rm[1].toLowerCase(), realm: rm[2].toLowerCase(), name, role };
    }

    // Fallback: the "Realm, REGION" text in the card sub-title.
    const subtitle = card.querySelector('.card-sub-title')?.textContent || '';
    const sm = subtitle.match(/([^,|]+),\s*([A-Za-z]{2})(?![A-Za-z])/);
    if (sm) {
        return {
            region: sm[2].toLowerCase(),
            realm:  sm[1].trim().replace(/\s+/g, '-').toLowerCase(),
            name,
            role,
        };
    }
    return null;
}

// ─── Standard filter ──────────────────────────────────────────────────────────

function filterCards(minIlvl, minMythicKills, minMythicPlusScore, selectedClasses, selectedRoles) {
    assertSelector('#recruits-list', document, 'GoW recruits-list');

    for (const card of document.querySelectorAll('#recruits-list .card')) {
        // Keep WCL-hidden cards hidden through standard re-filters
        if (card.dataset.wclHidden === 'true') { card.style.display = 'none'; continue; }

        const ilvl        = getCardIlvl(card);
        const mythicKills = getCardMythicKills(card);
        const mplusScore  = getCardMythicPlusScore(card);
        const playerClass = getCardClass(card);
        const role        = getCardRole(card);

        const visible =
            (minIlvl          === 0 || ilvl        === null || ilvl        >= minIlvl) &&
            (minMythicKills   === 0 || mythicKills  === null || mythicKills >= minMythicKills) &&
            (minMythicPlusScore === 0 || mplusScore  === null || mplusScore  >= minMythicPlusScore) &&
            (selectedClasses.length === 0 || playerClass === null || selectedClasses.includes(playerClass)) &&
            (selectedRoles.length   === 0 || role        === null || selectedRoles.includes(role));

        card.style.display = visible ? '' : 'none';
    }
}

// ─── WCL scoring ──────────────────────────────────────────────────────────────

let gowWclThresholds  = { minBest: 0, minMedian: 0, hideUnknown: false };
let gowHiddenCount    = 0;
let gowSummaryAnchor  = null;

function applyWclScoring(wclSettings) {
    gowWclThresholds = wclSettings;
    const cards = Array.from(document.querySelectorAll('#recruits-list .card'))
        .filter(card => card.style.display !== 'none' && !card.dataset.wclScored);

    if (cards.length === 0) return;

    for (const card of cards) {
        const nameEl = card.querySelector('.character-name, h3, .card-title') || card;
        setBadgeState(nameEl, 'pending', null, gowWclThresholds, null);
    }

    const total = document.querySelectorAll('#recruits-list .card').length;
    gowHiddenCount = document.querySelectorAll('#recruits-list .card[data-wcl-hidden="true"]').length;
    // Re-resolve the anchor each pass: GoW can swap #recruits-list on a page
    // change, leaving a cached anchor detached (upsertFilterSummary would then
    // bail on its null parentNode and the summary would stop updating).
    if (!gowSummaryAnchor || !gowSummaryAnchor.isConnected) {
        gowSummaryAnchor = document.querySelector('#recruits-list');
    }
    upsertFilterSummary(gowSummaryAnchor, gowHiddenCount, total);

    runWithConcurrency(cards, async (card) => {
        card.dataset.wclScored = 'pending';
        const character = getCardCharacter(card);
        const nameEl    = card.querySelector('.character-name, h3, .card-title') || card;

        if (!character) {
            card.dataset.wclScored = 'done';
            setBadgeState(nameEl, 'error', { error: 'Could not read character link' }, gowWclThresholds);
            return;
        }

        const score = await requestWclScore(character);
        card.dataset.wclScored = 'done';

        let badgeState = 'score';
        if (score.error && score.rateLimitMs)                                    badgeState = 'rate-limited';
        else if (score.error)                                                     badgeState = 'error';
        else if (score.notFound || (score.best === null && score.median === null)) badgeState = 'no-logs';

        setBadgeState(nameEl, badgeState, score, gowWclThresholds, character.role);

        if (failsWclThresholds(score, gowWclThresholds, character.role)) {
            card.dataset.wclHidden = 'true';
            card.style.display = 'none';
            gowHiddenCount++;
        }
        upsertFilterSummary(gowSummaryAnchor, gowHiddenCount, total);
    }, wclSettings.concurrency || 4);
}

// ─── Live settings re-evaluation ──────────────────────────────────────────────

const GOW_WCL_KEYS = [
    'gowWclEnabled', 'gowWclMinBest', 'gowWclMinMedian', 'gowWclHideUnknown',
    'gowWclMinBestHealer', 'gowWclMinMedianHealer', 'gowWclMinBestTank', 'gowWclMinMedianTank',
    'wclConcurrency',
];

watchSettings(GOW_WCL_KEYS, (changes) => {
    const allCards = Array.from(document.querySelectorAll('#recruits-list .card'));
    clearWclMarkers(allCards);
    gowHiddenCount = 0;
    loadSettingsAndFilter();
});

// ─── Main settings + filter pass ──────────────────────────────────────────────

function loadSettingsAndFilter() {
    chrome.storage.sync.get(
        ['gowMinIlvl', 'gowMinMythicKills', 'gowMinMythicPlusScore', 'gowSelectedClasses', 'gowSelectedRoles',
         'gowWclEnabled', 'gowWclMinBest', 'gowWclMinMedian', 'gowWclHideUnknown',
         'gowWclMinBestHealer', 'gowWclMinMedianHealer', 'gowWclMinBestTank', 'gowWclMinMedianTank',
         'wclConcurrency'],
        function(options) {
            filterCards(
                parseFloat(options.gowMinIlvl)          || 0,
                parseInt(options.gowMinMythicKills)      || 0,
                parseInt(options.gowMinMythicPlusScore)  || 0,
                options.gowSelectedClasses || [],
                options.gowSelectedRoles   || []
            );
            if (options.gowWclEnabled) {
                applyWclScoring({
                    minBest:         parseInt(options.gowWclMinBest)         || 0,
                    minMedian:       parseInt(options.gowWclMinMedian)       || 0,
                    minBestHealer:   parseInt(options.gowWclMinBestHealer)   || 0,
                    minMedianHealer: parseInt(options.gowWclMinMedianHealer) || 0,
                    minBestTank:     parseInt(options.gowWclMinBestTank)     || 0,
                    minMedianTank:   parseInt(options.gowWclMinMedianTank)   || 0,
                    hideUnknown:     !!options.gowWclHideUnknown,
                    concurrency:     getConcurrency(options),
                });
            }
        }
    );
}

// ─── Observer + init ──────────────────────────────────────────────────────────

let filterTimer = null;
let gowObserver = null;
let observedContainer = null;

// (Re)attach the card observer to the current #recruits-list. GoW replaces this
// element on some pagination / route changes, which orphans the previous
// observer and silently stops filtering on later pages. Re-attach whenever a
// new container element appears; the identity check keeps this a no-op while the
// same container persists (infinite-scroll appends fire the existing observer).
function observeRecruitsContainer() {
    const container = document.querySelector('#recruits-list');
    if (!container || container === observedContainer) return;

    if (gowObserver) gowObserver.disconnect();
    observedContainer = container;
    gowObserver = new MutationObserver(() => {
        clearTimeout(filterTimer);
        filterTimer = setTimeout(loadSettingsAndFilter, 300);
    });
    gowObserver.observe(container, { childList: true });
    loadSettingsAndFilter();
}

function watchForContainer() {
    // Catches the first appearance and any later container replacement.
    observeRecruitsContainer();
    setInterval(observeRecruitsContainer, 1000);
}

chrome.storage.sync.get('guildsofwowEnabled', function(options) {
    if (options.guildsofwowEnabled !== false) watchForContainer();
});
