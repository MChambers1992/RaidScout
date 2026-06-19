const SETTINGS_KEYS = [
    'warcraftlogsEnabled', 'parseThreshold', 'bestParseThreshold', 'wclSearchParseThreshold', 'wclSelectedRegions', 'wclMinMythicKills',
    'wowprogressEnabled', 'openWarcraftLogsTab', 'minIlvl', 'maxIlvl', 'selectedRegions', 'guildFilter',
    'raiderioEnabled', 'openWarcraftLogsFromRaiderIO', 'hideRaiderIoAds',
    'rioMinIlvl', 'rioSelectedRegions', 'rioSelectedRoles',
    'guildsofwowEnabled', 'gowMinIlvl', 'gowMinMythicKills', 'gowMinMythicPlusScore', 'gowSelectedRoles',
];

const SITE_PANEL_MAP = {
    'warcraftlogs.com': 'warcraftlogs',
    'wowprogress.com':  'wowprogress',
    'raider.io':        'raiderio',
    'guildsofwow.com':  'guildsofwow',
};

function getSiteFromUrl(url) {
    if (!url) return null;
    for (const [domain, site] of Object.entries(SITE_PANEL_MAP)) {
        if (url.includes(domain)) return site;
    }
    return null;
}

function loadBadge() {
    chrome.action.getBadgeText({}, text => {
        if (text && text !== '') {
            document.getElementById('badgeCount').textContent = text;
            document.getElementById('badgeArea').classList.add('visible');
        }
    });
}

function applySettings(data) {
    document.getElementById('q-warcraftlogsEnabled').checked = data.warcraftlogsEnabled !== false;
    document.getElementById('q-parseThreshold').value = data.parseThreshold ?? 50;
    document.getElementById('q-bestParseThreshold').value = data.bestParseThreshold ?? 60;

    document.getElementById('q-wclSearchParseThreshold').value = data.wclSearchParseThreshold || '';

    const savedWclRegions = data.wclSelectedRegions ?? [];
    document.querySelectorAll('.q-wclRegionFilter').forEach(cb => {
        cb.checked = savedWclRegions.includes(cb.value);
    });
    document.getElementById('q-wclMinMythicKills').value = data.wclMinMythicKills || '';

    document.getElementById('q-wowprogressEnabled').checked = data.wowprogressEnabled !== false;
    document.getElementById('q-minIlvl').value = data.minIlvl || '';
    document.getElementById('q-maxIlvl').value = data.maxIlvl || '';
    document.getElementById('q-guildFilter').value = data.guildFilter ?? 'any';
    document.getElementById('q-openWarcraftLogsTab').checked = data.openWarcraftLogsTab !== false;

    const savedRegions = data.selectedRegions ?? ['EU'];
    document.querySelectorAll('.q-regionFilter').forEach(cb => {
        cb.checked = savedRegions.includes(cb.value);
    });

    document.getElementById('q-raiderioEnabled').checked = data.raiderioEnabled !== false;
    document.getElementById('q-openWarcraftLogsFromRaiderIO').checked = data.openWarcraftLogsFromRaiderIO !== false;
    document.getElementById('q-hideRaiderIoAds').checked = data.hideRaiderIoAds !== false;
    document.getElementById('q-rioMinIlvl').value = data.rioMinIlvl || '';

    const savedRioRegions = data.rioSelectedRegions ?? [];
    document.querySelectorAll('.q-rioRegionFilter').forEach(cb => {
        cb.checked = savedRioRegions.includes(cb.value);
    });

    const savedRioRoles = data.rioSelectedRoles ?? [];
    document.querySelectorAll('.q-rioRoleFilter').forEach(cb => {
        cb.checked = savedRioRoles.includes(cb.value);
    });

    document.getElementById('q-guildsofwowEnabled').checked = data.guildsofwowEnabled !== false;
    document.getElementById('q-gowMinIlvl').value = data.gowMinIlvl || '';
    document.getElementById('q-gowMinMythicKills').value = data.gowMinMythicKills || '';
    document.getElementById('q-gowMinMythicPlusScore').value = data.gowMinMythicPlusScore || '';

    const savedRoles = data.gowSelectedRoles ?? [];
    document.querySelectorAll('.q-roleFilter').forEach(cb => {
        cb.checked = savedRoles.includes(cb.value);
    });
}

let saveTimer = null;
let savedFadeTimer = null;

function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveAll, 400);
}

function saveAll() {
    const wclSelectedRegions = Array.from(document.querySelectorAll('.q-wclRegionFilter:checked')).map(cb => cb.value);
    const selectedRegions = Array.from(document.querySelectorAll('.q-regionFilter:checked')).map(cb => cb.value);
    const gowSelectedRoles = Array.from(document.querySelectorAll('.q-roleFilter:checked')).map(cb => cb.value);
    const rioSelectedRegions = Array.from(document.querySelectorAll('.q-rioRegionFilter:checked')).map(cb => cb.value);
    const rioSelectedRoles = Array.from(document.querySelectorAll('.q-rioRoleFilter:checked')).map(cb => cb.value);

    chrome.storage.sync.set({
        warcraftlogsEnabled: document.getElementById('q-warcraftlogsEnabled').checked,
        parseThreshold: parseInt(document.getElementById('q-parseThreshold').value) || 50,
        bestParseThreshold: parseInt(document.getElementById('q-bestParseThreshold').value) || 60,
        wclSearchParseThreshold: parseInt(document.getElementById('q-wclSearchParseThreshold').value) || 0,
        wclSelectedRegions,
        wclMinMythicKills: parseInt(document.getElementById('q-wclMinMythicKills').value) || 0,

        wowprogressEnabled: document.getElementById('q-wowprogressEnabled').checked,
        openWarcraftLogsTab: document.getElementById('q-openWarcraftLogsTab').checked,
        minIlvl: parseFloat(document.getElementById('q-minIlvl').value) || 0,
        maxIlvl: parseFloat(document.getElementById('q-maxIlvl').value) || 0,
        selectedRegions,
        guildFilter: document.getElementById('q-guildFilter').value,

        raiderioEnabled: document.getElementById('q-raiderioEnabled').checked,
        openWarcraftLogsFromRaiderIO: document.getElementById('q-openWarcraftLogsFromRaiderIO').checked,
        hideRaiderIoAds: document.getElementById('q-hideRaiderIoAds').checked,
        rioMinIlvl: parseFloat(document.getElementById('q-rioMinIlvl').value) || 0,
        rioSelectedRegions,
        rioSelectedRoles,

        guildsofwowEnabled: document.getElementById('q-guildsofwowEnabled').checked,
        gowMinIlvl: parseFloat(document.getElementById('q-gowMinIlvl').value) || 0,
        gowMinMythicKills: parseInt(document.getElementById('q-gowMinMythicKills').value) || 0,
        gowMinMythicPlusScore: parseInt(document.getElementById('q-gowMinMythicPlusScore').value) || 0,
        gowSelectedRoles,
    }, showSaved);
}

function showSaved() {
    const indicator = document.getElementById('savedIndicator');
    indicator.textContent = '✓ Saved';
    indicator.classList.add('visible');
    clearTimeout(savedFadeTimer);
    savedFadeTimer = setTimeout(() => indicator.classList.remove('visible'), 1600);
}

document.addEventListener('DOMContentLoaded', function () {
    chrome.storage.sync.get(SETTINGS_KEYS, applySettings);
    loadBadge();

    // Detect current tab's site and expand its panel
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        const site = getSiteFromUrl(tabs[0]?.url);
        if (site) {
            document.getElementById('panel-' + site)?.classList.add('open');
        }
    });

    // Accordion — click panel header to expand/collapse
    document.querySelectorAll('.panel-header').forEach(header => {
        header.addEventListener('click', function (e) {
            // Clicks on the toggle switch should not collapse the panel
            if (e.target.closest('.toggle-switch')) return;
            this.closest('.site-panel').classList.toggle('open');
        });
    });

    // Auto-save on any input change
    document.querySelectorAll('input, select').forEach(el => {
        el.addEventListener('change', scheduleSave);
        if (el.type === 'number') el.addEventListener('input', scheduleSave);
    });

    // Clear badge counter
    document.getElementById('clearBadge').addEventListener('click', function () {
        chrome.runtime.sendMessage({ action: 'clearBadge' });
        document.getElementById('badgeArea').classList.remove('visible');
    });

    // Open full settings page
    document.getElementById('openSettings').addEventListener('click', function () {
        chrome.runtime.openOptionsPage();
    });
});
