import { getCharacterScore, clearScoreCache, hasCredentials, testCredentials, storeSecret, getRateLimitStatus } from './wcl-api.js';

// ─── Badge / closed-tab count (persisted across service-worker restarts) ───────

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
}

// ─── URL helpers ───────────────────────────────────────────────────────────────

const WOWPROGRESS_HOST = 'wowprogress.com';
const WCL_HOST         = 'www.warcraftlogs.com';
const WCL_ORIGIN       = 'https://www.warcraftlogs.com';

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

// ─── Navigation listener ───────────────────────────────────────────────────────

chrome.webNavigation.onCompleted.addListener(function(details) {
    chrome.storage.sync.get(['wowprogressEnabled', 'openWarcraftLogsTab'], function(options) {
        if (options.wowprogressEnabled !== false && options.openWarcraftLogsTab && isWowProgressCharacterPage(details.url)) {
            const wclUrl = buildWarcraftLogsUrl(details.url);
            if (wclUrl) chrome.tabs.create({ url: wclUrl });
        }
    });
}, { url: [{ hostContains: WOWPROGRESS_HOST }] });

// ─── Sync message listener (fire-and-forget) ───────────────────────────────────

chrome.runtime.onMessage.addListener(function(message, sender) {
    if (!isTrustedSender(sender)) return;

    if (message.action === 'parseThresholdFailed') {
        chrome.tabs.remove(sender.tab.id);
        closeWowProgressTab(message.warcraftLogsUrl);
        updateBadge();
    }

    if (message.action === 'openTab') {
        if (isAllowedTabUrl(message.url)) {
            chrome.tabs.create({ url: message.url });
        }
    }

    if (message.action === 'clearBadge') {
        closedTabCount = 0;
        chrome.storage.session.set({ wclClosedTabCount: 0 }).catch(() => {});
        chrome.action.setBadgeText({ text: '' });
    }
});

// ─── Async message listener (returns true to keep channel open) ────────────────

chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    const trusted = isTrustedSender(sender);

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

    if (message.action === 'getRateLimitStatus') {
        getRateLimitStatus().then(sendResponse);
        return true;
    }
});
