let warcraftLogsRedirected = false;
let filterSettings = { minIlvl: 0, selectedClasses: [], selectedRoles: [], selectedRegions: [] };

function isRaiderIoCharacterPage() {
    return window.location.pathname.includes("/characters/");
}

function isSearchPage() {
    return window.location.href.includes("raider.io/search") &&
           window.location.href.includes("recruitment.guild_raids");
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

    // Use URLSearchParams only for checking — never for re-serialising the URL.
    // params.toString() percent-encodes bracket characters ([→%5B), which breaks
    // Raider.IO's own param parsing and causes it to apply stale session filters.
    const href = window.location.href;
    const params = new URLSearchParams(window.location.search);
    const toAppend = [];

    if (!params.has("recruitment.guild_raids.profile.published_at[0][gte]")) {
        toAppend.push("recruitment.guild_raids.profile.published_at%5B0%5D%5Bgte%5D=1");
    }

    if (!params.has("sort[recruitment.guild_raids.profile.published_at]")) {
        toAppend.push("sort%5Brecruitment.guild_raids.profile.published_at%5D=desc");
    }

    if (toAppend.length > 0) {
        window.location.replace(href + (href.includes('?') ? '&' : '?') + toAppend.join('&'));
    }
}

function handleWarcraftLogsRedirection(enabled) {
    if (!enabled || warcraftLogsRedirected) return;

    if (isRaiderIoCharacterPage()) {
        setTimeout(() => {
            if (warcraftLogsRedirected) return;

            const warcraftLogsUrl = convertRaiderIoToWarcraftLogs(window.location.href);
            if (warcraftLogsUrl) {
                sendMessageToBackground('openTab', { url: warcraftLogsUrl });
                warcraftLogsRedirected = true;
            }
        }, 500);
    }
}

function hideAds() {
    const style = document.createElement('style');
    // Selectors targeting Raider.IO ad containers — update if the site changes its markup
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

// Normalise Raider.IO class title attribute to storage format.
// "Death Knight" → "deathknight", "Demon Hunter" → "demon_hunter", others → lowercase.
function normalizeRioClass(title) {
    if (!title) return null;
    const lower = title.toLowerCase();
    if (lower === 'death knight') return 'deathknight';
    if (lower === 'demon hunter') return 'demon_hunter';
    return lower;
}

function getRowData(row) {
    const cells = row.querySelectorAll('.rt-td');
    if (cells.length < 6) return null;

    // Cell 1: class icon — first slds-avatar title gives the class name
    const playerClass = normalizeRioClass(cells[1]?.querySelector('.slds-avatar[title]')?.title ?? null);

    // Cell 2: realm link text is "(US) Frostmourne" — extract the region prefix
    const realmText = cells[2]?.querySelector('.rio-realm-link')?.textContent ?? '';
    const region = realmText.match(/^\(([A-Z]+)\)/)?.[1] ?? null;

    // Cell 4: item level number
    const ilvlText = cells[4]?.querySelector('.slds-text-align--center')?.textContent.trim() ?? '';
    const ilvl = parseFloat(ilvlText);

    // Cell 5: main role icon carries a role CSS class
    const roleCell = cells[5];
    let role = null;
    if (roleCell?.querySelector('.tank-lfg-rio')) role = 'tank';
    else if (roleCell?.querySelector('.healer-lfg-rio')) role = 'healer';
    else if (roleCell?.querySelector('.dps-lfg-rio')) role = 'dps';

    return { playerClass, region, ilvl: isNaN(ilvl) ? null : ilvl, role };
}

function filterSearchRows() {
    if (!isSearchPage()) return;

    const { minIlvl, selectedClasses, selectedRoles, selectedRegions } = filterSettings;

    for (const group of document.querySelectorAll('.rt-tr-group')) {
        const row = group.querySelector('.rt-tr');
        if (!row) continue;
        const data = getRowData(row);
        if (!data) continue;

        const visible =
            (minIlvl === 0 || data.ilvl === null || data.ilvl >= minIlvl) &&
            (selectedClasses.length === 0 || data.playerClass === null || selectedClasses.includes(data.playerClass)) &&
            (selectedRoles.length === 0 || data.role === null || selectedRoles.includes(data.role)) &&
            (selectedRegions.length === 0 || data.region === null || selectedRegions.includes(data.region));

        group.style.display = visible ? '' : 'none';
    }
}

let observerTimer = null;
function observePageChanges(wclEnabled) {
    const observer = new MutationObserver(() => {
        clearTimeout(observerTimer);
        observerTimer = setTimeout(() => {
            enforceSortingAndPublishedColumn();
            handleWarcraftLogsRedirection(wclEnabled);
            filterSearchRows();
        }, 250);
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

chrome.storage.sync.get([
    'raiderioEnabled', 'openWarcraftLogsFromRaiderIO', 'hideRaiderIoAds',
    'rioMinIlvl', 'rioSelectedClasses', 'rioSelectedRoles', 'rioSelectedRegions',
], function(options) {
    if (options.raiderioEnabled === false) return;

    const wclEnabled = options.openWarcraftLogsFromRaiderIO !== false;
    filterSettings = {
        minIlvl: parseFloat(options.rioMinIlvl) || 0,
        selectedClasses: options.rioSelectedClasses || [],
        selectedRoles: options.rioSelectedRoles || [],
        selectedRegions: options.rioSelectedRegions || [],
    };

    enforceSortingAndPublishedColumn();
    observePageChanges(wclEnabled);
    handleWarcraftLogsRedirection(wclEnabled);
    filterSearchRows();

    if (options.hideRaiderIoAds) hideAds();
});
