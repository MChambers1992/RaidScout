document.addEventListener("DOMContentLoaded", function () {
    const categorySelect = document.getElementById("categorySelect");
    const categories = document.querySelectorAll(".category-content");

    function showCategory(category) {
        categories.forEach(cat => cat.style.display = "none");
        document.getElementById(category).style.display = "block";
    }

    // Load last selected category or default to Warcraft Logs
    const savedCategory = localStorage.getItem("selectedCategory") || "warcraftlogs";
    categorySelect.value = savedCategory;
    showCategory(savedCategory);

    categorySelect.addEventListener("change", function () {
        localStorage.setItem("selectedCategory", this.value);
        showCategory(this.value);
    });

    // Default values
    const defaultSettings = {
        parseThreshold: 50,
        bestParseThreshold: 60,
        openWarcraftLogsTab: true,
        region: "EU",
        minIlvl: 635,
        openWarcraftLogsFromRaiderIO: true,
        hideRaiderIoAds: true,
    };

    // Load saved settings or apply defaults
    chrome.storage.sync.get(Object.keys(defaultSettings), function (data) {
        document.getElementById("parseThreshold").value = data.parseThreshold ?? defaultSettings.parseThreshold;
        document.getElementById("bestParseThreshold").value = data.bestParseThreshold ?? defaultSettings.bestParseThreshold;
        document.getElementById("openWarcraftLogsTab").checked = data.openWarcraftLogsTab ?? defaultSettings.openWarcraftLogsTab;
        document.getElementById("region").value = data.region ?? defaultSettings.region;
        document.getElementById("minIlvl").value = data.minIlvl ?? defaultSettings.minIlvl;
        document.getElementById("openWarcraftLogsFromRaiderIO").checked = data.openWarcraftLogsFromRaiderIO ?? defaultSettings.openWarcraftLogsFromRaiderIO;
        document.getElementById("hideRaiderIoAds").checked = data.hideRaiderIoAds ?? defaultSettings.hideRaiderIoAds;
    });

    // Save settings
    document.getElementById("saveButton").addEventListener("click", function () {
        chrome.storage.sync.set({
            parseThreshold: parseInt(document.getElementById("parseThreshold").value) || defaultSettings.parseThreshold,
            bestParseThreshold: parseInt(document.getElementById("bestParseThreshold").value) || defaultSettings.bestParseThreshold,
            openWarcraftLogsTab: document.getElementById("openWarcraftLogsTab").checked,
            region: document.getElementById("region").value || defaultSettings.region,
            minIlvl: parseInt(document.getElementById("minIlvl").value) || defaultSettings.minIlvl,
            openWarcraftLogsFromRaiderIO: document.getElementById("openWarcraftLogsFromRaiderIO").checked,
            hideRaiderIoAds: document.getElementById("hideRaiderIoAds").checked

        }, function () {
            const status = document.getElementById("statusMessage");
            status.textContent = "Settings saved!";
            setTimeout(() => status.textContent = "", 2000);
        });
    });
});