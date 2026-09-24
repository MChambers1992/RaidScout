import {
    getCharacterScore, clearScoreCache, hasCredentials, testCredentials,
    storeSecret, getApiStatus, clearCloudflareBackoff,
} from './wcl-api.js';
import { buildScoutThresholds, scoutVerdict, characterFromWclUrl, WCL_ORIGIN as SCOUT_WCL_ORIGIN } from './preflight.js';

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

// Parsed from the pathname, not by splitting the whole URL: a query string or
// hash on the WoWProgress page (`…/Thrall?tab=gear`, `…/Thrall#pve`) used to
// ride along into the name segment and send WarcraftLogs a character that does
// not exist.
function buildWarcraftLogsUrl(wowProgressUrl) {
    let parts;
    try {
        parts = new URL(wowProgressUrl).pathname.split('/').filter(Boolean);
    } catch {
        return null;
    }
    const charIdx = parts.indexOf('character');
    if (charIdx === -1 || parts.length < charIdx + 4) return null;
    const [region, realm, character] = parts.slice(charIdx + 1, charIdx + 4);
    return `${WCL_ORIGIN}/character/${region.toLowerCase()}/${realm.toLowerCase()}/${character}`;
}

// Identity of a WCL character URL for comparisons: WarcraftLogs treats names
// case-insensitively, and characterFromWclUrl already normalises region/realm.
function wclCharacterKey(wclUrl) {
    const c = characterFromWclUrl(wclUrl);
    return c ? `${c.region}/${c.realm}/${c.name.toLowerCase()}` : null;
}

// True when two WoWProgress URLs are the same character page. Query string and
// hash are ignored (a sort or anchor is still the same candidate), and region
// and realm compare case-insensitively; the name is decoded before comparing so
// `Ch%C3%A9` and `Ché` agree.
function isSameWowProgressCharacter(a, b) {
    const key = url => {
        try {
            const parts = new URL(url).pathname.split('/').filter(Boolean);
            const idx = parts.indexOf('character');
            if (idx === -1 || parts.length < idx + 4) return null;
            const [region, realm, name] = parts.slice(idx + 1, idx + 4);
            return `${region.toLowerCase()}/${realm.toLowerCase()}/${decodeURIComponent(name)}`;
        } catch {
            return null;
        }
    };
    const ka = key(a);
    return ka !== null && ka === key(b);
}

// Close `tabId` only if it is still showing the character page the decision was
// made about. Pre-flight answers asynchronously — a token exchange plus a
// GraphQL call, up to the 10 s fetch timeout each — and the user can navigate
// that tab in the meantime: back to the gearscore listing they clicked through
// from, or on to the next candidate. Closing by id alone then took the listing
// (or the next candidate) with it. The tab is re-read at close time, which is
// what the pre-1.4 closeWowProgressTab() got right by matching on URL.
async function closeTabIfStillOn(tabId, expectedUrl) {
    let tab;
    try {
        tab = await chrome.tabs.get(tabId);
    } catch {
        return false;   // already closed
    }
    // tab.url is the committed URL; pendingUrl is set while a new navigation is
    // loading, and a tab mid-navigation away from the candidate is not theirs.
    if (tab.pendingUrl && !isSameWowProgressCharacter(tab.pendingUrl, expectedUrl)) return false;
    if (!isSameWowProgressCharacter(tab.url, expectedUrl)) return false;
    await chrome.tabs.remove(tabId).catch(() => {});
    return true;
}

// ─── Repeat-visit guard ────────────────────────────────────────────────────────
// webNavigation.onCompleted fires for every load of the character page, not
// once per visit. WoWProgress is behind Cloudflare, which serves its challenge
// at the page's own URL and reloads it once the check passes — two completed
// loads, two scouts, two identical WarcraftLogs tabs. A reload or a Back/
// Forward onto the page did the same. The first scout for a character from a
// given tab claims it for SCOUT_REPEAT_WINDOW_MS; repeats inside that window
// are dropped. Claimed before any await, so two events racing each other
// still produce one tab.
//
// In memory on purpose: the duplicates arrive seconds apart, while the worker
// is necessarily awake handling them.

const SCOUT_REPEAT_WINDOW_MS = 30_000;
const recentScouts = new Map();   // `${sourceTabId}|${characterKey}` → claimed-at ms

function claimScout(sourceTabId, wclUrl, now = Date.now()) {
    const key = `${sourceTabId ?? '-'}|${wclCharacterKey(wclUrl) ?? wclUrl}`;
    for (const [k, at] of recentScouts) {
        if (now - at >= SCOUT_REPEAT_WINDOW_MS) recentScouts.delete(k);
    }
    if (recentScouts.has(key)) return false;
    recentScouts.set(key, now);
    return true;
}

// ─── Scouted-tab registry ──────────────────────────────────────────────────────
// warcraftlogs.js runs on every WarcraftLogs character page, and its backstop
// asks for the tab to be closed whenever the character is below threshold. The
// background used to comply unconditionally — so a WCL page the user opened
// themselves (a link from Discord, a bookmark, a search) was closed out from
// under them, and every WoWProgress tab showing that character went with it.
// The settings promise to close an *auto-opened* tab, so that is now the only
// kind closed: each tab scoutAndOpenTab creates is recorded here with the page
// that asked for it, and parseThresholdFailed acts only on a recorded tab
// still showing the character it was opened for.
//
// storage.session rather than memory: the backstop can report long after the
// tab opened (it waits out a Cloudflare challenge first), well past the ~30 s
// an idle MV3 worker survives.

const SCOUTED_TABS_KEY = 'scoutedTabs';

async function readScoutedTabs() {
    const stored = await chrome.storage.session.get(SCOUTED_TABS_KEY).catch(() => ({}));
    return stored?.[SCOUTED_TABS_KEY] || {};
}

// Every write is a read-modify-write of one object, and two scouts can finish
// together (two WoWProgress tabs restored at once), so updates are queued: an
// interleaved pair would otherwise drop whichever record was written first.
let scoutedTabsQueue = Promise.resolve();
function updateScoutedTabs(mutate) {
    const run = scoutedTabsQueue.then(async () => {
        const tabs = await readScoutedTabs();
        const result = mutate(tabs);
        await chrome.storage.session.set({ [SCOUTED_TABS_KEY]: tabs }).catch(() => {});
        return result;
    });
    scoutedTabsQueue = run.catch(() => {});
    return run;
}

function rememberScoutedTab(tabId, record) {
    return updateScoutedTabs(tabs => { tabs[tabId] = record; });
}

// Removes and returns the record, or null when the tab was never ours.
function forgetScoutedTab(tabId) {
    return updateScoutedTabs(tabs => {
        const record = tabs[tabId] ?? null;
        delete tabs[tabId];
        return record;
    });
}

// The backstop reported `tabId` below threshold. Returns true when it acted.
async function handleParseThresholdFailed(tabId, warcraftLogsUrl, score) {
    const record = (await readScoutedTabs())[tabId];
    if (!record) return false;                              // not a tab we opened
    // The user may have navigated our tab on to another character; that page
    // is theirs now, and so is the decision about it.
    const key = wclCharacterKey(warcraftLogsUrl);
    if (!key || key !== wclCharacterKey(record.wclUrl)) return false;

    // Claimed through the queue so a duplicate report cannot close twice or
    // count the skip twice.
    if (!await forgetScoutedTab(tabId)) return false;
    await chrome.tabs.remove(tabId).catch(() => {});
    if (record.closeSource && record.sourceTabId != null && record.sourceUrl) {
        await closeTabIfStillOn(record.sourceTabId, record.sourceUrl);
    }
    await recordScoutSkip(characterFromWclUrl(warcraftLogsUrl), score);
    updateBadge();
    return true;
}

chrome.tabs.onRemoved.addListener(tabId => { forgetScoutedTab(tabId).catch(() => {}); });

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

// Content scripts: trusted only when running on one of the recruitment sites.
// Tab-bound actions (closing tabs, opening tabs) accept nothing else.
function isTrustedTabSender(sender) {
    if (!sender?.tab?.url) return false;
    try {
        const host = new URL(sender.tab.url).hostname;
        return TRUSTED_HOSTS.includes(host);
    } catch {
        return false;
    }
}

// Our own extension pages — the Scout page above all — need the same scoring
// path the content scripts use, and the host check above rejects them because
// their hostname is the extension id rather than a recruitment site.
//
// The trust boundary here is the URL: only this extension's own pages have a
// chrome-extension://<our id>/ URL, and the browser sets sender.url, not the
// page. The sender.id check keeps it closed to other extensions.
//
// This deliberately does NOT require sender.tab to be absent. It used to, on the
// assumption that an extension page has no tab — but Chrome populates
// sender.tab for anything sent from a tab, and the Scout page is opened with
// chrome.tabs.create, so it always had one. The guard rejected every scoring
// request Scout ever made: they came back UNTRUSTED_SENDER and every candidate
// rendered a "⚠ WCL err" badge. Separation from the tab-bound actions is not
// lost, because it never rested on this: the sync listener that closes and
// opens tabs checks isTrustedTabSender alone.
function isExtensionPageSender(sender) {
    if (!sender || sender.id !== chrome.runtime.id) return false;
    if (typeof sender.url !== 'string') return false;
    return sender.url.startsWith(chrome.runtime.getURL(''));
}

function isTrustedSender(sender) {
    return isTrustedTabSender(sender) || isExtensionPageSender(sender);
}

// Exported for tests/background-senders.test.js and
// tests/background-source-tab.test.js. The listeners below are the
// only production callers; nothing imports background.js.
export {
    isTrustedTabSender, isExtensionPageSender, isTrustedSender, TRUSTED_HOSTS,
    isSameWowProgressCharacter, closeTabIfStillOn,
    buildWarcraftLogsUrl, claimScout, scoutAndOpenTab, handleParseThresholdFailed,
    SCOUT_REPEAT_WINDOW_MS,
};

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
async function scoutAndOpenTab(wclUrl, { sourceTabId = null, sourceUrl = null, closeSourceTabOnReject = false } = {}) {
    if (!claimScout(sourceTabId, wclUrl)) {
        return { opened: false, verdict: 'duplicate', score: null };
    }

    const { preflight, openInBackground, thresholds } = await readScoutSettings();

    let result = { verdict: 'unknown', score: null, character: null };
    if (preflight && await hasCredentials()) {
        result = await scoutCharacterUrl(wclUrl, thresholds);
    }

    if (result.verdict === 'reject') {
        await recordScoutSkip(result.character, result.score);
        updateBadge();
        if (closeSourceTabOnReject && sourceTabId != null) {
            await closeTabIfStillOn(sourceTabId, sourceUrl);
        }
        return { opened: false, verdict: result.verdict, score: result.score };
    }

    const tab = await chrome.tabs.create({ url: wclUrl, active: !openInBackground });
    if (tab?.id != null) {
        await rememberScoutedTab(tab.id, {
            wclUrl, sourceTabId, sourceUrl, closeSource: closeSourceTabOnReject,
        });
    }
    return { opened: true, verdict: result.verdict, score: result.score };
}

// ─── Navigation listener ───────────────────────────────────────────────────────

chrome.webNavigation.onCompleted.addListener(function(details) {
    if (details.frameId !== 0) return;
    if (!isWowProgressCharacterPage(details.url)) return;

    chrome.storage.sync.get(['wowprogressEnabled', 'openWarcraftLogsTab'], function(options) {
        // `!== false`: the setting defaults to on (the popup and options page
        // both show it ticked), so an install that never saved it must open
        // tabs too. A truthy check left it silently off until the first Save.
        if (options.wowprogressEnabled === false || options.openWarcraftLogsTab === false) return;
        const wclUrl = buildWarcraftLogsUrl(details.url);
        if (!wclUrl) return;
        scoutAndOpenTab(wclUrl, {
            sourceTabId: details.tabId,
            sourceUrl: details.url,
            closeSourceTabOnReject: true,
        });
    });
}, { url: [{ hostContains: WOWPROGRESS_HOST }] });

// ─── Sync message listener (fire-and-forget) ───────────────────────────────────

chrome.runtime.onMessage.addListener(function(message, sender) {
    if (!isTrustedTabSender(sender)) return;

    if (message.action === 'parseThresholdFailed') {
        handleParseThresholdFailed(sender.tab.id, message.warcraftLogsUrl, message.score)
            .catch(() => {});
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
        // Tab-bound action: it reads sender.tab.id and can close the source tab,
        // so it takes the host-allowlist check specifically, not the widened
        // `trusted` that also admits extension pages. An extension page reaching
        // here would have thrown on sender.tab.id and left the caller's message
        // channel hanging.
        if (!isTrustedTabSender(sender) || !isAllowedTabUrl(message.url)) {
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
