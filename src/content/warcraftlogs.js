function isWarcraftLogsPage() {
    return window.location.hostname === "www.warcraftlogs.com";
}

function isRecruitmentSearchPage() {
    return window.location.pathname.startsWith('/recruitment/');
}

// ─── Character page: parse threshold monitoring ───────────────────────────────

function getMedianPerfAvg() {
    const selector = "#top-box > div:nth-child(2) > div:nth-child(2) > table > tbody > tr:nth-child(1) > td:nth-child(2)";
    const element = document.querySelector(selector);
    return element ? parseFloat(element.textContent.replace(/[^\d.]/g, "")) : null;
}

function getBestPerfAvg() {
    const selector = "#top-box > div.stats > div.best-perf-avg > b";
    const element = document.querySelector(selector);
    return element ? parseFloat(element.textContent.replace(/[^\d.]/g, "")) : null;
}

let checkInterval = null;
let checkAttempts = 0;
const MAX_CHECK_ATTEMPTS = 30;

function checkAndCloseWarcraftLogsTab() {
    checkAttempts++;

    if (checkAttempts >= MAX_CHECK_ATTEMPTS) {
        clearInterval(checkInterval);
        return;
    }

    const medianPerfAvg = getMedianPerfAvg();
    const bestPerfAvg = getBestPerfAvg();

    if (medianPerfAvg === null && bestPerfAvg === null) {
        return;
    }

    chrome.storage.sync.get(["parseThreshold", "bestParseThreshold"], function(options) {
        const parseThreshold = options.parseThreshold || 0;
        const bestParseThreshold = options.bestParseThreshold || 0;

        const belowThreshold =
            (medianPerfAvg !== null && medianPerfAvg < parseThreshold) ||
            (bestPerfAvg !== null && bestPerfAvg < bestParseThreshold);

        clearInterval(checkInterval);

        if (belowThreshold) {
            sendMessageToBackground('parseThresholdFailed', { warcraftLogsUrl: window.location.href });
        }
    });
}

function waitForPageLoad() {
    if (document.readyState === "complete") {
        checkInterval = setInterval(checkAndCloseWarcraftLogsTab, 1000);
    } else {
        window.addEventListener("load", () => {
            checkInterval = setInterval(checkAndCloseWarcraftLogsTab, 1000);
        });
    }
}

// ─── Recruitment search page: result filtering ────────────────────────────────

const WCL_CLASS_MAP = {
    'Warrior': 'warrior',
    'Paladin': 'paladin',
    'Hunter': 'hunter',
    'Rogue': 'rogue',
    'Priest': 'priest',
    'Shaman': 'shaman',
    'Mage': 'mage',
    'Warlock': 'warlock',
    'Monk': 'monk',
    'Druid': 'druid',
    'DeathKnight': 'deathknight',
    'DemonHunter': 'demon_hunter',
    'Evoker': 'evoker',
};

function getRecruitmentParseScore(card) {
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
            return WCL_CLASS_MAP[cls] ?? cls.toLowerCase();
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
    const parseThreshold = options.parseThreshold || 0;
    const wclSelectedRegions = options.wclSelectedRegions || [];
    const wclSelectedClasses = options.wclSelectedClasses || [];
    const wclMinMythicKills = options.wclMinMythicKills || 0;

    document.querySelectorAll('.recruitment-search-result').forEach(card => {
        const parseScore = getRecruitmentParseScore(card);
        const region = getRecruitmentRegion(card);
        const charClass = getRecruitmentClass(card);
        const mythicKills = getRecruitmentMythicKills(card);

        let hide = false;
        if (!hide && parseThreshold > 0 && parseScore !== null && parseScore < parseThreshold) hide = true;
        if (!hide && wclSelectedRegions.length > 0 && region && !wclSelectedRegions.includes(region)) hide = true;
        if (!hide && wclSelectedClasses.length > 0 && charClass && !wclSelectedClasses.includes(charClass)) hide = true;
        if (!hide && wclMinMythicKills > 0 && mythicKills < wclMinMythicKills) hide = true;

        card.style.display = hide ? 'none' : '';
    });
}

function initRecruitmentFiltering() {
    const storageKeys = ['parseThreshold', 'wclSelectedRegions', 'wclSelectedClasses', 'wclMinMythicKills'];

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
    chrome.storage.sync.get('warcraftlogsEnabled', function(options) {
        if (options.warcraftlogsEnabled !== false) {
            if (isRecruitmentSearchPage()) {
                initRecruitmentFiltering();
            } else {
                waitForPageLoad();
            }
        }
    });
}
