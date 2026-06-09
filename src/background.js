let closedTabCount = 0;

function updateBadge() {
    closedTabCount++;
    chrome.action.setBadgeText({ text: String(closedTabCount) });
    chrome.action.setBadgeBackgroundColor({ color: '#c0392b' });
}

function isWowProgressCharacterPage(url) {
    return url.includes('wowprogress.com/character');
}

function buildWarcraftLogsUrl(wowProgressUrl) {
    const urlParts = wowProgressUrl.split('/');
    const charIdx = urlParts.indexOf('character');
    const region = urlParts[charIdx + 1];
    const realm = urlParts[charIdx + 2];
    const characterName = urlParts[charIdx + 3];
    return `https://www.warcraftlogs.com/character/${region.toLowerCase()}/${realm.toLowerCase()}/${characterName}`;
}

function closeWowProgressTab(warcraftLogsUrl) {
    const urlParts = warcraftLogsUrl.split('/');
    const charIdx = urlParts.indexOf('character');
    const region = urlParts[charIdx + 1];
    const realm = urlParts[charIdx + 2];
    const characterName = urlParts[charIdx + 3]?.split('?')[0];

    const wowProgressPattern = `https://www.wowprogress.com/character/${region}/${realm}/${characterName}*`;
    chrome.tabs.query({ url: wowProgressPattern }, (tabs) => {
        tabs.forEach((tab) => chrome.tabs.remove(tab.id));
    });
}

chrome.webNavigation.onCompleted.addListener(function(details) {
    chrome.storage.sync.get('openWarcraftLogsTab', function(options) {
        if (options.openWarcraftLogsTab && isWowProgressCharacterPage(details.url)) {
            chrome.tabs.create({ url: buildWarcraftLogsUrl(details.url) });
        }
    });
}, { url: [{ hostContains: 'wowprogress.com' }] });

chrome.runtime.onMessage.addListener(function(message, sender) {
    if (message.action === 'parseThresholdFailed') {
        chrome.tabs.remove(sender.tab.id);
        closeWowProgressTab(message.warcraftLogsUrl);
        updateBadge();
    }

    if (message.action === 'openTab') {
        chrome.tabs.create({ url: message.url });
    }

    if (message.action === 'clearBadge') {
        closedTabCount = 0;
        chrome.action.setBadgeText({ text: '' });
    }
});
