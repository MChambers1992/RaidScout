let warcraftLogsRedirected = false;

function isRaiderIoCharacterPage() {
    return window.location.pathname.includes("/characters/");
}

function convertRaiderIoToWarcraftLogs(raiderIoUrl) {
    try {
        const url = new URL(raiderIoUrl);
        const pathParts = url.pathname.split('/');

        if (pathParts.length < 5 || pathParts[1] !== "characters") {
            console.error("Invalid Raider.IO URL format");
            return null;
        }

        const region = pathParts[2].toLowerCase();
        const realm = pathParts[3].replace(/\s/g, "-");
        const character = pathParts[4];

        if (!region || !realm || !character) {
            console.error("Missing region, realm, or character in URL");
            return null;
        }

        return `https://www.warcraftlogs.com/character/${region}/${realm}/${character}`;
    } catch (error) {
        console.error("Error parsing Raider.IO URL:", error);
        return null;
    }
}

function enforceSortingAndPublishedColumn() {
    if (!window.location.href.includes("raider.io/search") || !window.location.href.includes("recruitment.guild_raids")) {
        return;
    }

    const url = new URL(window.location.href);
    const params = new URLSearchParams(url.search);
    let needsReload = false;

    if (!params.has("recruitment.guild_raids.profile.published_at[0][gte]")) {
        params.set("recruitment.guild_raids.profile.published_at[0][gte]", "1");
        needsReload = true;
    }

    if (!params.has("sort[recruitment.guild_raids.profile.published_at]")) {
        params.set("sort[recruitment.guild_raids.profile.published_at]", "desc");
        needsReload = true;
    }

    if (needsReload) {
        url.search = params.toString();
        window.location.replace(url.toString());
    }
}

function handleWarcraftLogsRedirection() {
    if (warcraftLogsRedirected) return;

    // Uses openWarcraftLogsFromRaiderIO — the correct key for this setting
    chrome.storage.sync.get("openWarcraftLogsFromRaiderIO", function(options) {
        if (options.openWarcraftLogsFromRaiderIO && isRaiderIoCharacterPage()) {
            setTimeout(() => {
                if (warcraftLogsRedirected) return;

                const warcraftLogsUrl = convertRaiderIoToWarcraftLogs(window.location.href);
                if (warcraftLogsUrl) {
                    // Open via background — window.open is blocked by the browser in content scripts
                    sendMessageToBackground('openTab', { url: warcraftLogsUrl });
                    warcraftLogsRedirected = true;
                }
            }, 500);
        }
    });
}

function hideAds() {
    const style = document.createElement('style');
    style.textContent = `
        .advertisement,
        .ad-container,
        [data-gg-ad],
        [id^="div-gpt-ad"],
        [class*="advertisement"],
        iframe[src*="doubleclick.net"],
        iframe[src*="googlesyndication.com"] {
            display: none !important;
        }
    `;
    document.head.appendChild(style);
}

// Debounced observer — avoids firing on every single DOM mutation on the page
let observerTimer = null;
function observePageChanges() {
    const observer = new MutationObserver(() => {
        clearTimeout(observerTimer);
        observerTimer = setTimeout(() => {
            enforceSortingAndPublishedColumn();
            handleWarcraftLogsRedirection();
        }, 250);
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

enforceSortingAndPublishedColumn();
observePageChanges();
handleWarcraftLogsRedirection();

chrome.storage.sync.get("hideRaiderIoAds", function(options) {
    if (options.hideRaiderIoAds) hideAds();
});
