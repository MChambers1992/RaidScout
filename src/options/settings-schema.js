// settings-schema.js
// Single source of truth for all sync-storage settings.
//
// Each entry describes one setting:
//   key        — chrome.storage.sync key
//   type       — 'bool' | 'int' | 'float' | 'string' | 'checkboxGroup'
//   default    — value used when key is absent
//   domId      — getElementById id (omit for checkboxGroup)
//   selector   — CSS selector for querySelectorAll (checkboxGroup only)
//   parse      — optional custom parse fn; receives raw string from DOM element
//
// load(data)  — reads data object, populates DOM
// collect()   — reads DOM, returns plain object to pass to chrome.storage.sync.set
//
// checkboxGroup items are not in the sync.set object directly — they're
// collected via their selector and their key mapped manually in collect().

const SCHEMA = [
    // ── WarcraftLogs ─────────────────────────────────────────────────────────
    { key: 'warcraftlogsEnabled',        type: 'bool',   default: true,  domId: 'warcraftlogsEnabled' },
    { key: 'parseThreshold',             type: 'int',    default: 50,    domId: 'parseThreshold' },
    { key: 'bestParseThreshold',         type: 'int',    default: 60,    domId: 'bestParseThreshold' },
    // Shared proactive-scoring thresholds (drive WoWProgress/Raider.IO/GoW).
    // DPS Best/Median reuse bestParseThreshold/parseThreshold above.
    { key: 'wclMinBestHealer',           type: 'int',    default: 0,     domId: 'wclMinBestHealer' },
    { key: 'wclMinMedianHealer',         type: 'int',    default: 0,     domId: 'wclMinMedianHealer' },
    { key: 'wclMinBestTank',             type: 'int',    default: 0,     domId: 'wclMinBestTank' },
    { key: 'wclMinMedianTank',           type: 'int',    default: 0,     domId: 'wclMinMedianTank' },
    { key: 'wclHideUnknown',             type: 'bool',   default: false, domId: 'wclHideUnknown' },
    { key: 'wclSearchParseThreshold',    type: 'int',    default: 0,     domId: 'wclSearchParseThreshold' },
    { key: 'wclSearchProactive',         type: 'bool',   default: false, domId: 'wclSearchProactive' },
    { key: 'wclMinMythicKills',          type: 'int',    default: 0,     domId: 'wclMinMythicKills' },
    { key: 'wclClientId',                type: 'string', default: '',    domId: 'wclClientId' },
    { key: 'wclCacheTtlHours',           type: 'float',  default: 6,     domId: 'wclCacheTtlHours' },
    { key: 'wclDebug',                   type: 'bool',   default: false, domId: 'wclDebug' },
    { key: 'wclConcurrency',             type: 'int',    default: 4,     domId: 'wclConcurrency' },
    // Scout flow (shared by the WoWProgress and Raider.IO auto-open features)
    { key: 'scoutPreflight',             type: 'bool',   default: true,  domId: 'scoutPreflight' },
    { key: 'scoutOpenInBackground',      type: 'bool',   default: false, domId: 'scoutOpenInBackground' },
    { key: 'wclSelectedRegions',         type: 'checkboxGroup', default: [], selector: '.wclRegionFilter' },
    { key: 'wclSelectedClasses',         type: 'checkboxGroup', default: [], selector: '.wclClassFilter' },

    // ── WoWProgress ──────────────────────────────────────────────────────────
    { key: 'wowprogressEnabled',         type: 'bool',   default: true,  domId: 'wowprogressEnabled' },
    { key: 'openWarcraftLogsTab',        type: 'bool',   default: true,  domId: 'openWarcraftLogsTab' },
    { key: 'minIlvl',                    type: 'float',  default: 0,     domId: 'minIlvl' },
    { key: 'maxIlvl',                    type: 'float',  default: 0,     domId: 'maxIlvl' },
    { key: 'guildFilter',                type: 'string', default: 'any', domId: 'guildFilter' },
    { key: 'wpWclEnabled',               type: 'bool',   default: false, domId: 'wpWclEnabled' },
    { key: 'wpWclSort',                  type: 'bool',   default: false, domId: 'wpWclSort' },
    { key: 'selectedRegions',            type: 'checkboxGroup', default: ['EU'], selector: '.regionFilter' },
    { key: 'selectedClasses',            type: 'checkboxGroup', default: [],     selector: '.classFilter' },

    // ── Raider.IO ─────────────────────────────────────────────────────────────
    { key: 'raiderioEnabled',            type: 'bool',   default: true,  domId: 'raiderioEnabled' },
    { key: 'openWarcraftLogsFromRaiderIO', type: 'bool', default: true,  domId: 'openWarcraftLogsFromRaiderIO' },
    { key: 'hideRaiderIoAds',            type: 'bool',   default: true,  domId: 'hideRaiderIoAds' },
    { key: 'rioMinIlvl',                 type: 'float',  default: 0,     domId: 'rioMinIlvl' },
    { key: 'rioWclEnabled',              type: 'bool',   default: false, domId: 'rioWclEnabled' },
    { key: 'rioWclSort',                 type: 'bool',   default: false, domId: 'rioWclSort' },
    { key: 'rioSelectedRegions',         type: 'checkboxGroup', default: [], selector: '.rioRegionFilter' },
    { key: 'rioSelectedRoles',           type: 'checkboxGroup', default: [], selector: '.rioRoleFilter' },
    { key: 'rioSelectedClasses',         type: 'checkboxGroup', default: [], selector: '.rioClassFilter' },

    // ── Guilds of WoW ─────────────────────────────────────────────────────────
    { key: 'guildsofwowEnabled',         type: 'bool',   default: true,  domId: 'guildsofwowEnabled' },
    { key: 'gowMinIlvl',                 type: 'float',  default: 0,     domId: 'gowMinIlvl' },
    { key: 'gowMinMythicKills',          type: 'int',    default: 0,     domId: 'gowMinMythicKills' },
    { key: 'gowMinMythicPlusScore',      type: 'int',    default: 0,     domId: 'gowMinMythicPlusScore' },
    { key: 'gowWclEnabled',              type: 'bool',   default: false, domId: 'gowWclEnabled' },
    { key: 'gowWclSort',                 type: 'bool',   default: false, domId: 'gowWclSort' },
    { key: 'gowSelectedClasses',         type: 'checkboxGroup', default: [], selector: '.gowClassFilter' },
    { key: 'gowSelectedRoles',           type: 'checkboxGroup', default: [], selector: '.roleFilter' },
];

// All sync keys (used for chrome.storage.sync.get)
const ALL_KEYS = SCHEMA.map(s => s.key);

// Default values as a plain object
const DEFAULTS = Object.fromEntries(SCHEMA.map(s => [s.key, s.default]));

// Parse a raw DOM value for a given schema entry
function parseValue(entry, rawValue) {
    if (entry.type === 'bool')   return !!rawValue;
    if (entry.type === 'int')    return parseInt(rawValue)   || entry.default || 0;
    if (entry.type === 'float')  return parseFloat(rawValue) || entry.default || 0;
    if (entry.type === 'string') return rawValue ?? entry.default ?? '';
    return rawValue;
}

// Populate DOM from a storage data object
function loadFromData(data) {
    for (const entry of SCHEMA) {
        const value = data[entry.key] ?? entry.default;
        if (entry.type === 'checkboxGroup') {
            const arr = Array.isArray(value) ? value : entry.default;
            document.querySelectorAll(entry.selector).forEach(cb => {
                cb.checked = arr.includes(cb.value);
            });
        } else {
            const el = document.getElementById(entry.domId);
            if (!el) continue;
            if (entry.type === 'bool') el.checked = !!value;
            else                       el.value   = value === entry.default && value === 0 ? '' : (value ?? '');
        }
    }
}

// Collect DOM values into a plain object for chrome.storage.sync.set
function collectFromDom() {
    const result = {};
    for (const entry of SCHEMA) {
        if (entry.type === 'checkboxGroup') {
            result[entry.key] = Array.from(document.querySelectorAll(entry.selector + ':checked'))
                .map(cb => cb.value);
        } else {
            const el = document.getElementById(entry.domId);
            if (!el) { result[entry.key] = entry.default; continue; }
            const raw = entry.type === 'bool' ? el.checked : el.value;
            result[entry.key] = parseValue(entry, raw);
        }
    }
    return result;
}
