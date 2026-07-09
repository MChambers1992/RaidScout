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
function detectRoleFromPage() {
    const specIcon = document.querySelector('.player-character-spec img[alt]');
    if (!specIcon) return null;
    const alt = specIcon.alt.toLowerCase();
    const healerSpecs = ['restoration', 'holy', 'discipline', 'mistweaver', 'preservation'];
    const tankSpecs   = ['protection', 'guardian', 'blood', 'brewmaster', 'vengeance'];
    if (healerSpecs.some(s => alt.startsWith(s))) return 'healer';
    if (tankSpecs.some(s => alt.startsWith(s)))   return 'tank';
    return 'dps';
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
}

function initRecruitmentFiltering() {
    const storageKeys = ['wclSearchParseThreshold', 'wclSelectedRegions', 'wclSelectedClasses', 'wclMinMythicKills'];

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
        if (area === 'sync' && storageKeys.some(k => k in changes)) {
            applyFilters();
        }
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
