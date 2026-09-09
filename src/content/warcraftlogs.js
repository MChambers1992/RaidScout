// warcraftlogs.js — content script for www.warcraftlogs.com

function isWarcraftLogsPage() {
    return window.location.hostname === 'www.warcraftlogs.com';
}

function isRecruitmentSearchPage() {
    return window.location.pathname.startsWith('/recruitment/');
}

// ─── Character page: reactive tab-close via API ───────────────────────────────
// Backstop for the pre-flight scouting the background now does before opening
// this tab: it still runs for users without API credentials, and for tabs
// opened before settings changed. Scoring comes from the API, so this no
// longer needs anything from the page — which is what lets it work while
// Cloudflare is still showing its interstitial.

function extractCharacterFromUrl(url) {
    try {
        const parts = new URL(url).pathname.split('/').filter(Boolean);
        // pathname: /character/<region>/<realm>/<name>[/...]
        const idx = parts.indexOf('character');
        if (idx === -1 || parts.length < idx + 4) return null;
        return {
            region: parts[idx + 1].toLowerCase(),
            realm:  parts[idx + 2].toLowerCase(),
            name:   decodeURIComponent(parts[idx + 3].split('?')[0]),
            // 'auto' — the API resolves the role from the spec it ranked them
            // as, so we don't have to wait for the page to render a spec icon.
            role:   'auto',
        };
    } catch {
        return null;
    }
}

// isCloudflareChallengePage() lives in common.js — WoWProgress is behind the same
// interstitial and needs the same check. The real character page replaces the
// challenge after it passes, which re-runs this content script, so there is
// nothing to poll for meanwhile — and closing the tab mid-challenge is exactly
// what we want to avoid.

let reactiveCheckTimer = null;
let reactiveAttempts   = 0;
const MAX_REACTIVE_ATTEMPTS = 20;

function stopReactiveChecks() {
    clearInterval(reactiveCheckTimer);
    reactiveCheckTimer = null;
}

function checkAndCloseViaApi(character, thresholds) {
    // Don't burn the attempt budget — or close the tab — while Cloudflare is
    // still verifying. The page reloads itself once the check clears.
    if (isCloudflareChallengePage()) return;

    reactiveAttempts++;
    if (reactiveAttempts > MAX_REACTIVE_ATTEMPTS) {
        stopReactiveChecks();
        return;
    }

    // Ask background for the score (uses the proactive API path + cache)
    chrome.runtime.sendMessage({ action: 'fetchWclScore', character }, function (score) {
        if (!score || score.error) return;           // transient — keep polling
        if (score.notFound) { stopReactiveChecks(); return; } // no logs — leave tab open
        if (score.best === null && score.median === null) { stopReactiveChecks(); return; }

        stopReactiveChecks();

        // Role-aware: the API resolved the character's role from their ranked
        // spec, so a healer is judged against the healer thresholds here too
        // rather than against the DPS ones.
        const wclSettings = buildWclSettings(thresholds);
        if (failsWclThresholds(score, wclSettings, score.role)) {
            sendMessageToBackground('parseThresholdFailed', {
                warcraftLogsUrl: window.location.href,
                score,
            });
        }
    });
}

function waitForPageLoad(character) {
    chrome.storage.sync.get(SHARED_WCL_KEYS, function (thresholds) {
        const startCheck = () => {
            // Run once immediately: the score comes from the API, so there is
            // no reason to wait a second (or for Cloudflare) before asking.
            checkAndCloseViaApi(character, thresholds);
            reactiveCheckTimer = setInterval(
                () => checkAndCloseViaApi(character, thresholds),
                1000
            );
        };
        if (document.readyState === 'interactive' || document.readyState === 'complete') startCheck();
        else document.addEventListener('DOMContentLoaded', startCheck);
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
        role:   getRecruitmentRole(card) || 'auto',
    };
}

// Best-effort role detection from the result card. WCL's recruitment search
// markup for spec/role isn't confirmed here, so this returns null when it
// can't tell and the caller asks the API to resolve the role from the spec the
// character actually ranked as.
function getRecruitmentRole(card) {
    const roleText = (card.querySelector('[class*="spec"], [class*="role"]')?.textContent || '').toLowerCase();
    if (!roleText) return null;
    const healerSpecs = ['restoration', 'holy', 'discipline', 'mistweaver', 'preservation', 'healer'];
    const tankSpecs   = ['protection', 'guardian', 'blood', 'brewmaster', 'vengeance', 'tank'];
    if (healerSpecs.some(s => roleText.includes(s))) return 'healer';
    if (tankSpecs.some(s => roleText.includes(s)))   return 'tank';
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

        const badgeState = badgeStateForScore(score);
        const role       = effectiveRole(score, character.role);

        setBadgeState(nameCell, badgeState, score, wclSettings, role);

        if (failsWclThresholds(score, wclSettings, role)) {
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
    // Tell the background a real WarcraftLogs page rendered — that means this
    // browser has cleared any Cloudflare challenge, so API lookups that were
    // backed off can start again immediately.
    if (!isCloudflareChallengePage()) {
        sendMessageToBackground('wclPageReady');
    }

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
// There isn't one. Scout used to open /recruitment/ in a background tab and read
// the rows through registerHarvester(), but WarcraftLogs sits behind an
// aggressive Cloudflare configuration, so the source that most needed a tab was
// the one most likely to be served a challenge instead of a listing — the exact
// cost pre-flight scouting was built to stop paying.
//
// Their v2 API cannot stand in for it either: the Client API's root Query is
// characterData, gameData, guildData, progressRaceData, rateLimitData,
// reportData, userData, worldData and two report-component fields, and nothing in
// the published schema describes a recruitment post (the one "Recruit" in it is a
// guild rank). The recruitment Discord integration is an outbound webhook, not
// something a client can query.
//
// So WarcraftLogs contributes what only it can — the parses every candidate is
// ranked by — and Scout harvests names from the three sites that publish them.
// The recruitment-page filtering earlier in this file is unaffected: that is for
// browsing /recruitment/ yourself, which is still a perfectly good thing to do.
