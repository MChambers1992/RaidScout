// warcraftlogs.js — content script for www.warcraftlogs.com

function isWarcraftLogsPage() {
    return window.location.hostname === 'www.warcraftlogs.com';
}

function isRecruitmentSearchPage() {
    return window.location.pathname.startsWith('/recruitment/');
}

// ─── Character page: reactive tab-close via API ───────────────────────────────
// Replaces the brittle DOM-scraping polling loop. Extracts character identity
// from the current URL (the background opened this tab so the URL is canonical)
// and asks the background to score it via the WCL API.

function extractCharacterFromUrl(url) {
    try {
        const parts = new URL(url).pathname.split('/').filter(Boolean);
        // pathname: /character/<region>/<realm>/<name>[/...]
        const idx = parts.indexOf('character');
        if (idx === -1 || parts.length < idx + 4) return null;
        return {
            region: parts[idx + 1].toLowerCase(),
            realm:  parts[idx + 2].toLowerCase(),
            name:   parts[idx + 3].split('?')[0],
            role:   null, // will be detected below via page DOM
        };
    } catch {
        return null;
    }
}

// Try to read the character's primary role from the spec icon shown on their page.
// WCL renders a spec icon with an alt like "Restoration Druid" or "Protection Paladin".
// Role on a character page, from the selected spec icon. Shares the spec table
// in common.js rather than keeping its own copy — the two lists had already
// drifted from the recruitment-card version below.
function detectRoleFromPage() {
    const specIcon = document.querySelector('.player-character-spec img[alt]');
    return specIcon ? roleFromText(specIcon.alt) : null;
}

let reactiveCheckTimer = null;
let reactiveAttempts   = 0;
const MAX_REACTIVE_ATTEMPTS = 20;

function checkAndCloseViaApi(character, thresholds) {
    reactiveAttempts++;
    if (reactiveAttempts > MAX_REACTIVE_ATTEMPTS) {
        clearInterval(reactiveCheckTimer);
        return;
    }

    // Detect role from the rendered spec icon (loads async — wait up to 5 polls)
    const detectedRole = detectRoleFromPage();
    if (!detectedRole && reactiveAttempts < 5) return;
    character.role = detectedRole || character.role || 'dps';

    // Ask background for the score (uses the proactive API path + cache)
    chrome.runtime.sendMessage({ action: 'fetchWclScore', character }, function (score) {
        if (!score || score.error) return;           // transient — keep polling
        if (score.notFound) { clearInterval(reactiveCheckTimer); return; } // no logs — leave tab open
        if (score.best === null && score.median === null) return; // not loaded yet

        clearInterval(reactiveCheckTimer);

        const { parseThreshold = 0, bestParseThreshold = 0 } = thresholds;
        const belowThreshold =
            (score.median !== null && parseThreshold    > 0 && score.median < parseThreshold) ||
            (score.best   !== null && bestParseThreshold > 0 && score.best   < bestParseThreshold);

        if (belowThreshold) {
            sendMessageToBackground('parseThresholdFailed', { warcraftLogsUrl: window.location.href });
        }
    });
}

function waitForPageLoad(character) {
    chrome.storage.sync.get(['parseThreshold', 'bestParseThreshold'], function (thresholds) {
        const startCheck = () => {
            reactiveCheckTimer = setInterval(
                () => checkAndCloseViaApi(character, thresholds),
                1000
            );
        };
        if (document.readyState === 'complete') startCheck();
        else window.addEventListener('load', startCheck);
    });
}

// ─── Recruitment search page: result filtering ────────────────────────────────
// Note: this is the *WCL-hosted* recruitment search (/recruitment/), separate
// from the proactive scoring layer that operates on WoWProgress/Raider.IO/GoW.
// Both can be enabled simultaneously — they operate on different pages.

function getRecruitmentParseScore(card) {
    assertSelector('.recruitment-character-search-result-zone-metrics-tile__metrics', card, 'WCL recruitment parse score');
    const span = card.querySelector('.recruitment-character-search-result-zone-metrics-tile__metrics .icon__label > span');
    return span ? parseFloat(span.textContent) : null;
}

function getRecruitmentRegion(card) {
    const el = card.querySelector('.character-name-faction-server-region-title__region');
    return el ? el.textContent.trim() : null;
}

function getRecruitmentClass(card) {
    const el = card.querySelector('.character-name-faction-server-region-title__name');
    if (!el) return null;
    for (const cls of el.classList) {
        if (cls !== 'character-name-faction-server-region-title__name') {
            return normalizeClassName(cls);
        }
    }
    return null;
}

function getRecruitmentMythicKills(card) {
    const el = card.querySelector('.zone-progress-bar__label');
    if (!el) return 0;
    const match = el.textContent.match(/^(\d+)\/\d+ Mythic/);
    return match ? parseInt(match[1]) : 0;
}

function filterRecruitmentResults(options) {
    const parseThreshold    = options.wclSearchParseThreshold || 0;
    const wclSelectedRegions = options.wclSelectedRegions  || [];
    const wclSelectedClasses = options.wclSelectedClasses  || [];
    const wclMinMythicKills  = options.wclMinMythicKills   || 0;

    document.querySelectorAll('.recruitment-search-result').forEach(card => {
        // WCL-hidden cards stay hidden regardless of the flat threshold filter
        // below (matches the same guard used on WoWProgress/Raider.IO/GoW).
        if (card.dataset.wclHidden === 'true') { card.style.display = 'none'; return; }

        const parseScore  = getRecruitmentParseScore(card);
        const region      = getRecruitmentRegion(card);
        const charClass   = getRecruitmentClass(card);
        const mythicKills = getRecruitmentMythicKills(card);

        let hide = false;
        if (!hide && parseThreshold    > 0 && parseScore !== null && parseScore < parseThreshold) hide = true;
        if (!hide && wclSelectedRegions.length > 0 && region    && !wclSelectedRegions.includes(region))    hide = true;
        if (!hide && wclSelectedClasses.length > 0 && charClass && !wclSelectedClasses.includes(charClass)) hide = true;
        if (!hide && wclMinMythicKills  > 0 && mythicKills < wclMinMythicKills) hide = true;

        card.style.display = hide ? 'none' : '';
    });

    if (options.wclSearchProactive) applyProactiveScoring(options);
}

// ─── Proactive scoring on recruitment search (shares common.js flow) ──────────
// Optional layer on top of the flat wclSearchParseThreshold filter above: reuses
// the same requestWclScore/failsWclThresholds/badge machinery as WoWProgress,
// Raider.IO and GoW, so results get role-aware (DPS/Healer/Tank) thresholds and
// the same inline badges. Requires API credentials; off by default.

function getRecruitmentCharacter(card) {
    const link = card.querySelector('a[href*="/character/"]');
    if (!link) return null;
    const parts = link.getAttribute('href').split('?')[0].split('/').filter(Boolean);
    const idx = parts.indexOf('character');
    if (idx === -1 || parts.length < idx + 4) return null;
    return {
        region: parts[idx + 1].toLowerCase(),
        realm:  parts[idx + 2].toLowerCase(),
        name:   decodeURIComponent(parts[idx + 3]),
        role:   getRecruitmentRole(card),
    };
}

// Role for one recruitment result card.
//
// Returns null when the card does not say. It used to fall back to 'dps', which
// silently scored every healer it failed to recognise against a DPS threshold no
// healer can meet — the worst possible failure for this feature. A null costs
// nothing: roleToMetric() and thresholdsForRole() both already treat unknown as
// DPS, so behaviour is unchanged, while the merge in scout-core can now take a
// real role from another source and Scout's role filter can tell it is unknown.
//
// WCL's markup for spec is not confirmed, so several signals are tried rather
// than betting on one selector. The spec→role table lives in common.js so this
// and Raider.IO cannot drift apart.
function getRecruitmentRole(card) {
    // 1. A spec or role icon, where the answer is in an attribute.
    for (const el of card.querySelectorAll('img[alt], [title], [aria-label]')) {
        const role = roleFromText(el.getAttribute('alt') || el.getAttribute('title') ||
                                 el.getAttribute('aria-label'));
        if (role) return role;
    }

    // 2. A spec- or role-named element, read as text.
    for (const el of card.querySelectorAll('[class*="spec"], [class*="role"]')) {
        const role = roleFromText(el.textContent);
        if (role) return role;
    }

    // 3. A spec name carried as a CSS class, the way the character name element
    //    carries the class name (see getRecruitmentClass). Spec names only here:
    //    matching role words too would let a "damage-meter" class invent a role.
    for (const el of card.querySelectorAll('[class]')) {
        if (typeof el.className !== 'string') continue;
        const role = roleFromSpecText(el.className);
        if (role) return role;
    }

    return null;
}

function applyProactiveScoring(options) {
    const wclSettings = buildWclSettings(options);
    const cards = Array.from(document.querySelectorAll('.recruitment-search-result'))
        .filter(card => card.style.display !== 'none' && !card.dataset.wclScored);

    if (cards.length === 0) return;

    for (const card of cards) {
        const nameCell = card.querySelector('.character-name-faction-server-region-title__name') || card;
        setBadgeState(nameCell, 'pending', null, wclSettings);
    }

    const total = document.querySelectorAll('.recruitment-search-result').length;
    let hidden  = document.querySelectorAll('.recruitment-search-result[data-wcl-hidden="true"]').length;
    const summaryAnchor = document.querySelector('.guild-recruitment-search-results-tile__results');
    upsertFilterSummary(summaryAnchor, hidden, total);

    runWithConcurrency(cards, async (card) => {
        card.dataset.wclScored = 'pending';
        const character = getRecruitmentCharacter(card);
        const nameCell   = card.querySelector('.character-name-faction-server-region-title__name') || card;

        if (!character) {
            card.dataset.wclScored = 'done';
            return;
        }

        const score = await requestWclScore(character);
        card.dataset.wclScored = 'done';

        let badgeState = 'score';
        if (score.error && score.rateLimitMs)                                    badgeState = 'rate-limited';
        else if (score.error)                                                     badgeState = 'error';
        else if (score.notFound || (score.best === null && score.median === null)) badgeState = 'no-logs';

        setBadgeState(nameCell, badgeState, score, wclSettings, character.role);

        if (failsWclThresholds(score, wclSettings, character.role)) {
            card.dataset.wclHidden = 'true';
            card.style.display = 'none';
            hidden++;
        }
        upsertFilterSummary(summaryAnchor, hidden, total);
    }, wclSettings.concurrency || 4);
}

function initRecruitmentFiltering() {
    const storageKeys = [
        'wclSearchParseThreshold', 'wclSelectedRegions', 'wclSelectedClasses', 'wclMinMythicKills',
        'wclSearchProactive', ...SHARED_WCL_KEYS,
    ];

    function applyFilters() {
        chrome.storage.sync.get(storageKeys, filterRecruitmentResults);
    }

    const resultsObserver = new MutationObserver(applyFilters);

    function observeResults() {
        const container = document.querySelector('.guild-recruitment-search-results-tile__results');
        if (container) {
            resultsObserver.observe(container, { childList: true, subtree: false });
            applyFilters();
        } else {
            const bodyObserver = new MutationObserver(() => {
                const c = document.querySelector('.guild-recruitment-search-results-tile__results');
                if (c) {
                    bodyObserver.disconnect();
                    resultsObserver.observe(c, { childList: true, subtree: false });
                    applyFilters();
                }
            });
            bodyObserver.observe(document.body, { childList: true, subtree: true });
        }
    }

    // Live re-apply when any of the filter settings change (including class filter)
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync' || !storageKeys.some(k => k in changes)) return;

        // A proactive-scoring-relevant key changed — clear markers so cards
        // that were already scored/hidden get re-evaluated against the new
        // settings instead of keeping their stale badge/hidden state.
        if ('wclSearchProactive' in changes || SHARED_WCL_KEYS.some(k => k in changes)) {
            clearWclMarkers(document.querySelectorAll('.recruitment-search-result'));
        }
        applyFilters();
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', observeResults);
    } else {
        observeResults();
    }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

if (isWarcraftLogsPage()) {
    chrome.storage.sync.get('warcraftlogsEnabled', function (options) {
        if (options.warcraftlogsEnabled !== false) {
            if (isRecruitmentSearchPage()) {
                initRecruitmentFiltering();
            } else {
                // Character page — reactive tab close via API
                const character = extractCharacterFromUrl(window.location.href);
                if (character) {
                    waitForPageLoad(character);
                }
                // Fall back silently if URL doesn't parse (e.g. guild/zone pages)
            }
        }
    });
}

// ─── Scout harvest ─────────────────────────────────────────────────────────────
// Only meaningful on /recruitment/ — on a character page the ready selector
// never matches and the harvester reports back that nothing rendered.

registerHarvester('warcraftlogs', '.recruitment-search-result', function () {
    return Array.from(document.querySelectorAll('.recruitment-search-result'))
        .filter(card => card.style.display !== 'none' && card.dataset.wclHidden !== 'true')
        .map(card => {
            const character = getRecruitmentCharacter(card);
            if (!character) return null;
            const href = card.querySelector('a[href*="/character/"]')?.getAttribute('href');
            return {
                ...character,
                playerClass: getRecruitmentClass(card),
                mythicKills: getRecruitmentMythicKills(card),
                link:        href ? new URL(href, 'https://www.warcraftlogs.com').toString() : null,
            };
        })
        .filter(Boolean);
});
