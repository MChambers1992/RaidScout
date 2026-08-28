import {
    getCharacterScore, clearScoreCache, hasCredentials, testCredentials,
    storeSecret, getApiStatus, clearCloudflareBackoff,
} from './wcl-api.js';
import { buildScoutThresholds, scoutVerdict, characterFromWclUrl, WCL_ORIGIN as SCOUT_WCL_ORIGIN } from './scout.js';

// ─── Badge / skipped-candidate count (persisted across service-worker restarts) ─
// Counts candidates the scout flow rejected — pre-flight skips (no tab ever
// opened) and the older open-then-close path both feed the same counter.

let closedTabCount = 0;

async function initBadgeCount() {
    const { wclClosedTabCount } = await chrome.storage.session.get('wclClosedTabCount').catch(() => ({}));
    if (typeof wclClosedTabCount === 'number') {
        closedTabCount = wclClosedTabCount;
        if (closedTabCount > 0) {
            chrome.action.setBadgeText({ text: String(closedTabCount) });
            chrome.action.setBadgeBackgroundColor({ color: '#c0392b' });
        }
    }
}
initBadgeCount();

async function updateBadge() {
    closedTabCount++;
    await chrome.storage.session.set({ wclClosedTabCount: closedTabCount }).catch(() => {});
    chrome.action.setBadgeText({ text: String(closedTabCount) });
    chrome.action.setBadgeBackgroundColor({ color: '#c0392b' });
    broadcastBadgeUpdate();
}

function broadcastBadgeUpdate() {
    chrome.runtime.sendMessage({ action: 'badgeUpdated', count: closedTabCount }).catch(() => {});
}

// ─── URL helpers ───────────────────────────────────────────────────────────────

const WOWPROGRESS_HOST = 'wowprogress.com';
const WCL_HOST         = 'www.warcraftlogs.com';
const WCL_ORIGIN       = SCOUT_WCL_ORIGIN;

// Allowed URL prefixes for openTab — only ever open WCL pages
const ALLOWED_TAB_PREFIXES = [ WCL_ORIGIN + '/character/' ];

function isAllowedTabUrl(url) {
    try {
        return ALLOWED_TAB_PREFIXES.some(p => url.startsWith(p));
    } catch {
        return false;
    }
}

function isWowProgressCharacterPage(url) {
    return url.includes('wowprogress.com/character');
}

function buildWarcraftLogsUrl(wowProgressUrl) {
    const urlParts = wowProgressUrl.split('/');
    const charIdx = urlParts.indexOf('character');
    if (charIdx === -1 || urlParts.length < charIdx + 4) return null;
    const region    = urlParts[charIdx + 1];
    const realm     = urlParts[charIdx + 2];
    const character = urlParts[charIdx + 3];
    if (!region || !realm || !character) return null;
    return `${WCL_ORIGIN}/character/${region.toLowerCase()}/${realm.toLowerCase()}/${character}`;
}

function closeWowProgressTab(warcraftLogsUrl) {
    const urlParts = warcraftLogsUrl.split('/');
    const charIdx = urlParts.indexOf('character');
    if (charIdx === -1) return;
    const region    = urlParts[charIdx + 1];
    const realm     = urlParts[charIdx + 2];
    const character = urlParts[charIdx + 3]?.split('?')[0];
    if (!region || !realm || !character) return;
    const pattern = `https://www.wowprogress.com/character/${region}/${realm}/${character}*`;
    chrome.tabs.query({ url: pattern }, tabs => {
        tabs.forEach(tab => chrome.tabs.remove(tab.id));
    });
}

// ─── Sender validation ─────────────────────────────────────────────────────────

const TRUSTED_HOSTS = [
    WOWPROGRESS_HOST,
    'www.wowprogress.com',
    'raider.io',
    'www.raider.io',
    WCL_HOST,
    'guildsofwow.com',
    'www.guildsofwow.com',
];

function isTrustedSender(sender) {
    if (!sender?.tab?.url) return false;
    try {
        const host = new URL(sender.tab.url).hostname;
        return TRUSTED_HOSTS.includes(host);
    } catch {
        return false;
    }
}

// ─── Scout pre-flight ──────────────────────────────────────────────────────────
// The scout flow used to be: open the candidate's WarcraftLogs tab, let the
// content script read the page, close the tab again if they were below
// threshold. Every rejected candidate therefore had to clear WarcraftLogs'
// Cloudflare check before we could throw their tab away.
//
// Since scoring moved to the API we no longer need the page at all, so we ask
// the API *first* and only create a tab for candidates worth looking at.
// If the API can't answer (no credentials, error, rate limit, Cloudflare) the
// verdict is 'unknown' and we fall back to the original open-then-check flow —
// scouting never gets stricter because a lookup failed.

const SCOUT_SETTING_KEYS = [
    'scoutPreflight', 'scoutOpenInBackground',
    'parseThreshold', 'bestParseThreshold',
    'wclMinBestHealer', 'wclMinMedianHealer',
    'wclMinBestTank', 'wclMinMedianTank',
    'wclHideUnknown',
];

async function readScoutSettings() {
    const options = await chrome.storage.sync.get(SCOUT_SETTING_KEYS);
    return {
        preflight:        options.scoutPreflight !== false,   // default on
        openInBackground: !!options.scoutOpenInBackground,
        thresholds:       buildScoutThresholds(options),
    };
}

// Score a WCL character URL and decide whether it deserves a tab.
// Returns { verdict: 'open' | 'reject' | 'unknown', score, character }.
async function scoutCharacterUrl(wclUrl, thresholds) {
    const character = characterFromWclUrl(wclUrl);
    if (!character) return { verdict: 'unknown', score: null, character: null };

    // role 'auto' — one query returns both metrics and the ranked spec, so the
    // right thresholds get applied without any page to read the spec from.
    const score = await getCharacterScore({ ...character, role: 'auto' });
    const { verdict, reason } = scoutVerdict(score, thresholds, score?.role);
    return { verdict, reason, score, character };
}

// Remember the most recent skip so the popup can show what was filtered out —
// with no tab opening and closing there is otherwise nothing to see.
async function recordScoutSkip(character, score) {
    await chrome.storage.session.set({
        lastScoutSkip: {
            name:   character?.name   ?? null,
            realm:  character?.realm  ?? null,
            region: character?.region ?? null,
            role:   score?.role   ?? null,
            best:   score?.best   ?? null,
            median: score?.median ?? null,
            at:     Date.now(),
        },
    }).catch(() => {});
}

// Open a WarcraftLogs tab for a candidate, unless pre-flight scouting rejects
// them. `sourceTabId` is the page the request came from; it is closed on a
// reject only when the caller asks for it (WoWProgress parity — Raider.IO
// never closed its own tab).
async function scoutAndOpenTab(wclUrl, { sourceTabId = null, closeSourceTabOnReject = false } = {}) {
    const { preflight, openInBackground, thresholds } = await readScoutSettings();

    let result = { verdict: 'unknown', score: null, character: null };
    if (preflight && await hasCredentials()) {
        result = await scoutCharacterUrl(wclUrl, thresholds);
    }

    if (result.verdict === 'reject') {
        await recordScoutSkip(result.character, result.score);
        updateBadge();
        if (closeSourceTabOnReject && sourceTabId != null) {
            chrome.tabs.remove(sourceTabId).catch(() => {});
        }
        return { opened: false, verdict: result.verdict, score: result.score };
    }

    chrome.tabs.create({ url: wclUrl, active: !openInBackground });
    return { opened: true, verdict: result.verdict, score: result.score };
}

// ─── Navigation listener ───────────────────────────────────────────────────────

chrome.webNavigation.onCompleted.addListener(function(details) {
    if (details.frameId !== 0) return;
    if (!isWowProgressCharacterPage(details.url)) return;

    chrome.storage.sync.get(['wowprogressEnabled', 'openWarcraftLogsTab'], function(options) {
        if (options.wowprogressEnabled === false || !options.openWarcraftLogsTab) return;
        const wclUrl = buildWarcraftLogsUrl(details.url);
        if (!wclUrl) return;
        scoutAndOpenTab(wclUrl, { sourceTabId: details.tabId, closeSourceTabOnReject: true });
    });
}, { url: [{ hostContains: WOWPROGRESS_HOST }] });

// ─── Sync message listener (fire-and-forget) ───────────────────────────────────

chrome.runtime.onMessage.addListener(function(message, sender) {
    if (!isTrustedSender(sender)) return;

    if (message.action === 'parseThresholdFailed') {
        chrome.tabs.remove(sender.tab.id);
        closeWowProgressTab(message.warcraftLogsUrl);
        recordScoutSkip(characterFromWclUrl(message.warcraftLogsUrl), message.score);
        updateBadge();
    }

    // A real WarcraftLogs page rendered in a tab means the browser cleared any
    // Cloudflare challenge, so API lookups can retry immediately rather than
    // waiting out the backoff. (The interstitial itself doesn't send this.)
    if (message.action === 'wclPageReady') {
        clearCloudflareBackoff().catch(() => {});
    }

    if (message.action === 'clearBadge') {
        closedTabCount = 0;
        chrome.storage.session.set({ wclClosedTabCount: 0 }).catch(() => {});
        chrome.storage.session.remove('lastScoutSkip').catch(() => {});
        chrome.action.setBadgeText({ text: '' });
        broadcastBadgeUpdate();
    }
});

// ─── Async message listener (returns true to keep channel open) ────────────────

chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    const trusted = isTrustedSender(sender);

    // Raider.IO's character pages ask for the tab; pre-flight scouting decides
    // whether it actually opens. The response lets the content script tell the
    // user the candidate was skipped instead of silently doing nothing.
    if (message.action === 'openTab') {
        if (!trusted || !isAllowedTabUrl(message.url)) {
            sendResponse({ opened: false, verdict: 'unknown', reason: 'BLOCKED' });
            return true;
        }
        scoutAndOpenTab(message.url, { sourceTabId: sender.tab.id })
            .then(sendResponse)
            .catch(() => { chrome.tabs.create({ url: message.url }); sendResponse({ opened: true, verdict: 'unknown' }); });
        return true;
    }

    if (message.action === 'fetchWclScore') {
        if (!trusted) { sendResponse({ best: null, median: null, error: 'UNTRUSTED_SENDER' }); return true; }
        getCharacterScore(message.character)
            .then(sendResponse)
            .catch(err => sendResponse({ best: null, median: null, error: String(err) }));
        return true;
    }

    if (message.action === 'wclHasCredentials') {
        hasCredentials().then(has => sendResponse({ has }));
        return true;
    }

    if (message.action === 'testWclCredentials') {
        testCredentials().then(sendResponse);
        return true;
    }

    if (message.action === 'clearWclScoreCache') {
        clearScoreCache().then(() => sendResponse({ ok: true }));
        return true;
    }

    if (message.action === 'storeWclSecret') {
        storeSecret(message.secret).then(() => sendResponse({ ok: true }));
        return true;
    }

    if (message.action === 'getClosedTabCount') {
        sendResponse({ count: closedTabCount });
        return true;
    }

    if (message.action === 'getApiStatus') {
        getApiStatus().then(sendResponse);
        return true;
    }

    if (message.action === 'getLastScoutSkip') {
        chrome.storage.session.get('lastScoutSkip')
            .then(({ lastScoutSkip }) => sendResponse({ skip: lastScoutSkip || null }))
            .catch(() => sendResponse({ skip: null }));
        return true;
    }
});
