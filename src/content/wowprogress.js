// WoWProgress adds the WoW class as a CSS class on the .character element alongside "character".
// If the selectors ever change, update this list and getPlayerClass() below.
const WOW_CLASS_NAMES = [
    'warrior', 'paladin', 'hunter', 'rogue', 'priest',
    'shaman', 'mage', 'warlock', 'monk', 'druid',
    'deathknight', 'demon_hunter', 'evoker'
];

function getPlayerClass(playerRow) {
    const characterEl = playerRow.querySelector(".character");
    if (!characterEl) return null;
    for (const cls of characterEl.classList) {
        if (WOW_CLASS_NAMES.includes(cls)) return cls;
    }
    for (const cls of playerRow.classList) {
        if (WOW_CLASS_NAMES.includes(cls)) return cls;
    }
    return null;
}

function filterPlayers(selectedRegions, minIlvl, maxIlvl, selectedClasses, guildFilter) {
    const playerRows = document.querySelectorAll(".rating tr");

    for (let i = 1; i < playerRows.length; i++) {
        const playerRow = playerRows[i];
        const realmElement = playerRow.querySelector(".realm");
        const ilvlElement = playerRow.querySelector("td.center");
        const characterName = playerRow.querySelector(".character")?.textContent ?? "unknown";

        const playerIlvl = ilvlElement ? parseFloat(ilvlElement.textContent.trim()) : null;
        const playerClass = getPlayerClass(playerRow);
        const inGuild = playerRow.querySelector(".guild") !== null;

        const regionMatch = !realmElement ? false :
            selectedRegions.length === 0 || selectedRegions.some(r => realmElement.textContent.includes(r));
        const ilvlMatch = playerIlvl === null ||
            (playerIlvl >= minIlvl && (maxIlvl === 0 || playerIlvl <= maxIlvl));
        const classMatch = selectedClasses.length === 0 || playerClass === null || selectedClasses.includes(playerClass);
        const guildMatch = guildFilter === "any" || (guildFilter === "in" && inGuild) || (guildFilter === "out" && !inGuild);

        if (regionMatch && ilvlMatch && classMatch && guildMatch) {
            console.log(`✔ ${characterName} (${playerClass ?? "unknown"}, ilvl ${playerIlvl}, ${inGuild ? "guilded" : "unguilded"})`);
        } else {
            console.log(`❌ ${characterName} (${playerClass ?? "unknown"}, ilvl ${playerIlvl}, ${inGuild ? "guilded" : "unguilded"})`);
            playerRow.remove();
        }
    }
}

function loadSettingsAndFilter() {
    chrome.storage.sync.get(["selectedRegions", "region", "minIlvl", "maxIlvl", "selectedClasses", "guildFilter"], function(options) {
        // Graceful migration from old single-region key
        const selectedRegions = options.selectedRegions ?? (options.region ? [options.region] : ["EU"]);
        const minIlvl = parseFloat(options.minIlvl) || 0;
        const maxIlvl = parseFloat(options.maxIlvl) || 0;
        const selectedClasses = options.selectedClasses || [];
        const guildFilter = options.guildFilter || "any";
        filterPlayers(selectedRegions, minIlvl, maxIlvl, selectedClasses, guildFilter);
    });
}

function observeTableChanges() {
    const tableContainer = document.querySelector(".ratingContainer");
    if (!tableContainer) return;

    const observer = new MutationObserver((mutationsList) => {
        for (const mutation of mutationsList) {
            if (mutation.type === "childList") {
                loadSettingsAndFilter();
                break;
            }
        }
    });

    observer.observe(tableContainer, { childList: true, subtree: true });
    loadSettingsAndFilter();
}

function handlePageNavigation() {
    setInterval(() => {
        const table = document.querySelector(".ratingContainer table");
        if (table && !table.dataset.filtered) {
            table.dataset.filtered = "true";
            observeTableChanges();
        }
    }, 2000);
}

function hasRequiredParameters() {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.has("lang") && urlParams.has("raids_week");
}

function appendRequiredParameters(url) {
    const urlParams = new URLSearchParams(url.search);
    urlParams.set("lang", "en");
    urlParams.set("raids_week", "2");
    urlParams.set("sortby", "ts");
    return `${url.pathname}?${urlParams.toString()}`;
}

function redirectRealmPageIfNeeded() {
    const url = new URL(window.location.href);
    if (url.pathname.includes("/gearscore/") && url.search.includes("lfg=1")) {
        if (!hasRequiredParameters()) {
            window.location.href = appendRequiredParameters(url);
        }
    }
}

function isTargetPage() {
    const segments = new URL(window.location.href).pathname.split("/");
    return segments.length === 3 && segments[1] === "gearscore";
}

chrome.storage.sync.get('wowprogressEnabled', function(options) {
    if (options.wowprogressEnabled !== false) {
        redirectRealmPageIfNeeded();
        if (isTargetPage()) {
            observeTableChanges();
            handlePageNavigation();
        }
    }
});
