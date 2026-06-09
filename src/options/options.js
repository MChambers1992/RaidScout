document.addEventListener("DOMContentLoaded", function () {
    // Tab navigation
    const tabBtns = document.querySelectorAll(".tab-btn");
    const categories = document.querySelectorAll(".category-content");

    function showCategory(category) {
        categories.forEach(cat => cat.style.display = "none");
        document.getElementById(category).style.display = "block";
        tabBtns.forEach(btn => btn.classList.toggle("active", btn.dataset.tab === category));
    }

    const savedCategory = localStorage.getItem("selectedCategory") || "warcraftlogs";
    showCategory(savedCategory);

    tabBtns.forEach(btn => {
        btn.addEventListener("click", function () {
            localStorage.setItem("selectedCategory", this.dataset.tab);
            showCategory(this.dataset.tab);
        });
    });

    const defaultSettings = {
        warcraftlogsEnabled: true,
        parseThreshold: 50,
        bestParseThreshold: 60,
        wclSelectedRegions: [],
        wclMinMythicKills: 0,
        wclSelectedClasses: [],

        wowprogressEnabled: true,
        openWarcraftLogsTab: true,
        selectedRegions: ["EU"],
        minIlvl: 0,
        maxIlvl: 0,
        guildFilter: "any",
        selectedClasses: [],

        raiderioEnabled: true,
        openWarcraftLogsFromRaiderIO: true,
        hideRaiderIoAds: true,
        rioMinIlvl: 0,
        rioSelectedRegions: [],
        rioSelectedRoles: [],
        rioSelectedClasses: [],

        guildsofwowEnabled: true,
        gowMinIlvl: 0,
        gowMinMythicKills: 0,
        gowMinMythicPlusScore: 0,
        gowSelectedClasses: [],
        gowSelectedRoles: [],
    };

    chrome.storage.sync.get(Object.keys(defaultSettings), function (data) {
        document.getElementById("warcraftlogsEnabled").checked = data.warcraftlogsEnabled ?? defaultSettings.warcraftlogsEnabled;
        document.getElementById("parseThreshold").value = data.parseThreshold ?? defaultSettings.parseThreshold;
        document.getElementById("bestParseThreshold").value = data.bestParseThreshold ?? defaultSettings.bestParseThreshold;

        const savedWclRegions = data.wclSelectedRegions ?? defaultSettings.wclSelectedRegions;
        document.querySelectorAll(".wclRegionFilter").forEach(cb => {
            cb.checked = savedWclRegions.includes(cb.value);
        });

        document.getElementById("wclMinMythicKills").value = data.wclMinMythicKills || "";

        const savedWclClasses = data.wclSelectedClasses ?? defaultSettings.wclSelectedClasses;
        document.querySelectorAll(".wclClassFilter").forEach(cb => {
            cb.checked = savedWclClasses.includes(cb.value);
        });

        document.getElementById("wowprogressEnabled").checked = data.wowprogressEnabled ?? defaultSettings.wowprogressEnabled;
        document.getElementById("openWarcraftLogsTab").checked = data.openWarcraftLogsTab ?? defaultSettings.openWarcraftLogsTab;

        const savedRegions = data.selectedRegions ?? defaultSettings.selectedRegions;
        document.querySelectorAll(".regionFilter").forEach(cb => {
            cb.checked = savedRegions.includes(cb.value);
        });

        document.getElementById("minIlvl").value = data.minIlvl || "";
        document.getElementById("maxIlvl").value = data.maxIlvl || "";
        document.getElementById("guildFilter").value = data.guildFilter ?? defaultSettings.guildFilter;

        const savedClasses = data.selectedClasses ?? defaultSettings.selectedClasses;
        document.querySelectorAll(".classFilter").forEach(cb => {
            cb.checked = savedClasses.includes(cb.value);
        });

        document.getElementById("raiderioEnabled").checked = data.raiderioEnabled ?? defaultSettings.raiderioEnabled;
        document.getElementById("openWarcraftLogsFromRaiderIO").checked = data.openWarcraftLogsFromRaiderIO ?? defaultSettings.openWarcraftLogsFromRaiderIO;
        document.getElementById("hideRaiderIoAds").checked = data.hideRaiderIoAds ?? defaultSettings.hideRaiderIoAds;
        document.getElementById("rioMinIlvl").value = data.rioMinIlvl || "";

        const savedRioRegions = data.rioSelectedRegions ?? defaultSettings.rioSelectedRegions;
        document.querySelectorAll(".rioRegionFilter").forEach(cb => {
            cb.checked = savedRioRegions.includes(cb.value);
        });

        const savedRioRoles = data.rioSelectedRoles ?? defaultSettings.rioSelectedRoles;
        document.querySelectorAll(".rioRoleFilter").forEach(cb => {
            cb.checked = savedRioRoles.includes(cb.value);
        });

        const savedRioClasses = data.rioSelectedClasses ?? defaultSettings.rioSelectedClasses;
        document.querySelectorAll(".rioClassFilter").forEach(cb => {
            cb.checked = savedRioClasses.includes(cb.value);
        });

        document.getElementById("guildsofwowEnabled").checked = data.guildsofwowEnabled ?? defaultSettings.guildsofwowEnabled;
        document.getElementById("gowMinIlvl").value = data.gowMinIlvl || "";
        document.getElementById("gowMinMythicKills").value = data.gowMinMythicKills || "";
        document.getElementById("gowMinMythicPlusScore").value = data.gowMinMythicPlusScore || "";

        const savedGowClasses = data.gowSelectedClasses ?? defaultSettings.gowSelectedClasses;
        document.querySelectorAll(".gowClassFilter").forEach(cb => {
            cb.checked = savedGowClasses.includes(cb.value);
        });

        const savedRoles = data.gowSelectedRoles ?? defaultSettings.gowSelectedRoles;
        document.querySelectorAll(".roleFilter").forEach(cb => {
            cb.checked = savedRoles.includes(cb.value);
        });

        // Apply initial disabled state now that toggles have their correct values
        [
            ['warcraftlogsEnabled', 'warcraftlogs'],
            ['wowprogressEnabled',  'wowprogress'],
            ['raiderioEnabled',     'raiderio'],
            ['guildsofwowEnabled',  'guildsofwow'],
        ].forEach(([toggleId, sectionId]) => {
            const toggle  = document.getElementById(toggleId);
            const section = document.getElementById(sectionId);
            const sync = () => section.classList.toggle('section-disabled', !toggle.checked);
            sync();
            toggle.addEventListener('change', sync);
        });
    });

    document.getElementById("clearWclClasses").addEventListener("click", function () {
        document.querySelectorAll(".wclClassFilter").forEach(cb => cb.checked = false);
    });

    document.getElementById("clearClasses").addEventListener("click", function () {
        document.querySelectorAll(".classFilter").forEach(cb => cb.checked = false);
    });

    document.getElementById("clearGowClasses").addEventListener("click", function () {
        document.querySelectorAll(".gowClassFilter").forEach(cb => cb.checked = false);
    });

    document.getElementById("clearRioClasses").addEventListener("click", function () {
        document.querySelectorAll(".rioClassFilter").forEach(cb => cb.checked = false);
    });

    document.getElementById("saveButton").addEventListener("click", function () {
        const wclSelectedRegions = Array.from(document.querySelectorAll(".wclRegionFilter:checked")).map(cb => cb.value);
        const wclSelectedClasses = Array.from(document.querySelectorAll(".wclClassFilter:checked")).map(cb => cb.value);
        const selectedRegions = Array.from(document.querySelectorAll(".regionFilter:checked")).map(cb => cb.value);
        const selectedClasses = Array.from(document.querySelectorAll(".classFilter:checked")).map(cb => cb.value);
        const gowSelectedClasses = Array.from(document.querySelectorAll(".gowClassFilter:checked")).map(cb => cb.value);
        const gowSelectedRoles = Array.from(document.querySelectorAll(".roleFilter:checked")).map(cb => cb.value);
        const rioSelectedRegions = Array.from(document.querySelectorAll(".rioRegionFilter:checked")).map(cb => cb.value);
        const rioSelectedRoles = Array.from(document.querySelectorAll(".rioRoleFilter:checked")).map(cb => cb.value);
        const rioSelectedClasses = Array.from(document.querySelectorAll(".rioClassFilter:checked")).map(cb => cb.value);

        chrome.storage.sync.set({
            warcraftlogsEnabled: document.getElementById("warcraftlogsEnabled").checked,
            parseThreshold: parseInt(document.getElementById("parseThreshold").value) || defaultSettings.parseThreshold,
            bestParseThreshold: parseInt(document.getElementById("bestParseThreshold").value) || defaultSettings.bestParseThreshold,
            wclSelectedRegions,
            wclMinMythicKills: parseInt(document.getElementById("wclMinMythicKills").value) || 0,
            wclSelectedClasses,

            wowprogressEnabled: document.getElementById("wowprogressEnabled").checked,
            openWarcraftLogsTab: document.getElementById("openWarcraftLogsTab").checked,
            selectedRegions,
            minIlvl: parseFloat(document.getElementById("minIlvl").value) || 0,
            maxIlvl: parseFloat(document.getElementById("maxIlvl").value) || 0,
            guildFilter: document.getElementById("guildFilter").value,
            selectedClasses,

            raiderioEnabled: document.getElementById("raiderioEnabled").checked,
            openWarcraftLogsFromRaiderIO: document.getElementById("openWarcraftLogsFromRaiderIO").checked,
            hideRaiderIoAds: document.getElementById("hideRaiderIoAds").checked,
            rioMinIlvl: parseFloat(document.getElementById("rioMinIlvl").value) || 0,
            rioSelectedRegions,
            rioSelectedRoles,
            rioSelectedClasses,

            guildsofwowEnabled: document.getElementById("guildsofwowEnabled").checked,
            gowMinIlvl: parseFloat(document.getElementById("gowMinIlvl").value) || 0,
            gowMinMythicKills: parseInt(document.getElementById("gowMinMythicKills").value) || 0,
            gowMinMythicPlusScore: parseInt(document.getElementById("gowMinMythicPlusScore").value) || 0,
            gowSelectedClasses,
            gowSelectedRoles,
        }, function () {
            const status = document.getElementById("statusMessage");
            status.textContent = "✓ Settings saved";
            setTimeout(() => status.textContent = "", 2000);
        });
    });
});
