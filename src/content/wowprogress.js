console.log("WoWProgress Content script for realm page is running.");

// Function to remove players who do not meet the region or ilvl criteria
function filterPlayers(region, minIlvl) {
    const playerRows = document.querySelectorAll(".rating tr");
    const numRows = playerRows.length;

    console.log("Total rows found:", numRows);
    console.log(`Filtering for Region: ${region}, Min iLvl: ${minIlvl}`);

    for (let i = 1; i < numRows; i++) {
        const playerRow = playerRows[i];
        const realmElement = playerRow.querySelector(".realm");
        const ilvlElement = playerRow.querySelector("td.center");

        let playerIlvl = ilvlElement ? parseInt(ilvlElement.textContent.trim()) : null;

        const characterName = playerRow.querySelector(".character")?.textContent ?? "unknown";
        if (realmElement && realmElement.textContent.includes(region) && (playerIlvl === null || playerIlvl >= minIlvl)) {
            console.log(`✔ Player meets criteria: ${characterName}`);
        } else {
            console.log(`❌ Player does not meet criteria: ${characterName}`);
            playerRow.remove();
        }
    }
}

// Function to observe changes and reapply filtering
function observeTableChanges() {
    console.log("Observing table changes...");

    const tableContainer = document.querySelector(".ratingContainer");
    if (!tableContainer) {
        console.log("Table container not found. Exiting observation.");
        return;
    }

    const observer = new MutationObserver((mutationsList) => {
        console.log("Table content mutated. Reapplying filtering...");
        
        for (const mutation of mutationsList) {
            if (mutation.type === "childList") {
                console.log("🔄 Table content changed, applying filter...");
                
                chrome.storage.sync.get(["region", "minIlvl"], function (options) {
                    const region = options.region || "EU";
                    const minIlvl = options.minIlvl ? parseInt(options.minIlvl) : 0;
                    filterPlayers(region, minIlvl);
                });

                break; // Prevent redundant executions
            }
        }
    });

    observer.observe(tableContainer, { childList: true, subtree: true });

    // Also trigger filtering immediately in case the table is already loaded
    chrome.storage.sync.get(["region", "minIlvl"], function (options) {
        const region = options.region || "EU";
        const minIlvl = options.minIlvl ? parseInt(options.minIlvl) : 0;
        filterPlayers(region, minIlvl);
    });
}

// Ensure filtering runs when navigating between table pages
function handlePageNavigation() {
    console.log("Checking for table updates on navigation...");
    setInterval(() => {
        const table = document.querySelector(".ratingContainer table");
        if (table && !table.dataset.filtered) {
            console.log("🚀 Table reloaded, applying filters...");
            table.dataset.filtered = "true"; // Mark table as processed
            observeTableChanges();
        }
    }, 2000); // Check every 2 seconds
}

// Function to check if the URL contains required parameters
function hasRequiredParameters() {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.has("lang") && urlParams.has("raids_week");
}

// Function to append required parameters to the URL
function appendRequiredParameters(url) {
    const urlParams = new URLSearchParams(url.search);
    urlParams.set("lang", "en");
    urlParams.set("raids_week", "2");
    urlParams.set("sortby", "ts");
    return urlParams.toString() ? `${url.pathname}?${urlParams.toString()}` : url.pathname;
}

// Function to redirect to the correct page if needed
function redirectRealmPageIfNeeded() {
    const url = new URL(window.location.href);
    if (url.pathname.includes("/gearscore/") && url.search.includes("lfg=1")) {
        if (!hasRequiredParameters()) {
            const targetUrl = appendRequiredParameters(url);
            console.log("Redirecting to the target realm page:", targetUrl);
            window.location.href = targetUrl;
        }
    }
}

function isTargetPage() {
    const url = new URL(window.location.href);
    const path = url.pathname;
    const segments = path.split("/");
    return segments.length === 3 && segments[1] === "gearscore";
}

// Run filtering and observation on the correct page
redirectRealmPageIfNeeded();
if (isTargetPage()) {
    observeTableChanges();
    handlePageNavigation();
}