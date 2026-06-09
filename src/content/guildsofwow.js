// Guilds of WoW uses "Death Knight" / "Demon Hunter" in img alt text;
// normalise to match our storage format (deathknight / demon_hunter).
function normalizeGowClass(altText) {
    if (!altText) return null;
    const lower = altText.toLowerCase();
    if (lower === 'death knight') return 'deathknight';
    if (lower === 'demon hunter') return 'demon_hunter';
    return lower;
}

function getCardClass(card) {
    const classIcon = card.querySelector('img[src*="class-icons"]');
    return normalizeGowClass(classIcon?.alt ?? null);
}

function getCardRole(card) {
    const roleIcon = card.querySelector('img.role-icon[src]');
    if (!roleIcon) return null;
    const match = roleIcon.src.match(/raider-role-(\d+)/);
    if (!match) return null;
    return { '1': 'tank', '2': 'healer', '3': 'dps' }[match[1]] ?? null;
}

function getCardIlvl(card) {
    for (const fieldset of card.querySelectorAll('fieldset')) {
        if (fieldset.querySelector('legend')?.textContent.includes('Item Level')) {
            const text = fieldset.querySelector('.main-stat')?.textContent.trim() ?? '';
            const val = parseFloat(text.split('/')[0]);
            return isNaN(val) ? null : val;
        }
    }
    return null;
}

// Returns number of current-tier mythic kills (e.g. "6/9 M" → 6), or null if not shown.
function getCardMythicKills(card) {
    for (const fieldset of card.querySelectorAll('fieldset')) {
        if (fieldset.querySelector('legend')?.textContent.includes('Raid Progress')) {
            const text = fieldset.querySelector('.main-stat span')?.textContent.trim() ?? '';
            const match = text.match(/^(\d+)\/\d+\s*M/);
            return match ? parseInt(match[1]) : null;
        }
    }
    return null;
}

function getCardMythicPlusScore(card) {
    for (const fieldset of card.querySelectorAll('fieldset')) {
        if (fieldset.querySelector('legend')?.textContent.includes('M+')) {
            const text = fieldset.querySelector('.main-stat span')?.textContent.trim() ?? '';
            const val = parseInt(text);
            return isNaN(val) ? null : val;
        }
    }
    return null;
}

function filterCards(minIlvl, minMythicKills, minMythicPlusScore, selectedClasses, selectedRoles) {
    for (const card of document.querySelectorAll('#recruits-list .card')) {
        const ilvl = getCardIlvl(card);
        const mythicKills = getCardMythicKills(card);
        const mplusScore = getCardMythicPlusScore(card);
        const playerClass = getCardClass(card);
        const role = getCardRole(card);

        const visible =
            (minIlvl === 0 || ilvl === null || ilvl >= minIlvl) &&
            (minMythicKills === 0 || mythicKills === null || mythicKills >= minMythicKills) &&
            (minMythicPlusScore === 0 || mplusScore === null || mplusScore >= minMythicPlusScore) &&
            (selectedClasses.length === 0 || playerClass === null || selectedClasses.includes(playerClass)) &&
            (selectedRoles.length === 0 || role === null || selectedRoles.includes(role));

        card.style.display = visible ? '' : 'none';
    }
}

function loadSettingsAndFilter() {
    chrome.storage.sync.get(
        ['gowMinIlvl', 'gowMinMythicKills', 'gowMinMythicPlusScore', 'gowSelectedClasses', 'gowSelectedRoles'],
        function (options) {
            filterCards(
                parseFloat(options.gowMinIlvl) || 0,
                parseInt(options.gowMinMythicKills) || 0,
                parseInt(options.gowMinMythicPlusScore) || 0,
                options.gowSelectedClasses || [],
                options.gowSelectedRoles || []
            );
        }
    );
}

let filterTimer = null;

function observeRecruitsContainer() {
    const container = document.querySelector('#recruits-list');
    if (!container) return;

    new MutationObserver(() => {
        clearTimeout(filterTimer);
        filterTimer = setTimeout(loadSettingsAndFilter, 300);
    }).observe(container, { childList: true });

    loadSettingsAndFilter();
}

function waitForContainer() {
    if (document.querySelector('#recruits-list')) {
        observeRecruitsContainer();
        return;
    }

    // GoW is a SPA — the recruits list may not exist on initial parse
    const bodyObserver = new MutationObserver(() => {
        if (document.querySelector('#recruits-list')) {
            bodyObserver.disconnect();
            observeRecruitsContainer();
        }
    });

    bodyObserver.observe(document.body, { childList: true, subtree: true });
}

chrome.storage.sync.get('guildsofwowEnabled', function (options) {
    if (options.guildsofwowEnabled !== false) waitForContainer();
});
