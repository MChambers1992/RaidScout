const WOW_CLASS_NAMES = [
    'warrior', 'paladin', 'hunter', 'rogue', 'priest',
    'shaman', 'mage', 'warlock', 'monk', 'druid',
    'deathknight', 'demon_hunter', 'evoker'
];

function normalizeClassName(name) {
    if (!name) return null;
    const lower = name.toLowerCase();
    if (lower === 'death knight' || lower === 'deathknight') return 'deathknight';
    if (lower === 'demon hunter' || lower === 'demonhunter') return 'demon_hunter';
    return lower;
}

function sendMessageToBackground(action, data = {}) {
    chrome.runtime.sendMessage({ action, ...data });
}