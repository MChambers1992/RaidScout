// sources.js
// Source adapters for the Scout aggregator. Each adapter turns one recruitment
// site into a flat list of raw candidate rows, without the officer browsing there.
//
// Two harvest modes:
//
//   'fetch' — request the listing directly and parse it with DOMParser. Only
//             works for server-rendered listings; currently WoWProgress.
//
//   'tab'   — open the listing in a background tab, let this extension's own
//             content script render *and filter* it exactly as it would for a
//             human, then ask it for the visible rows via registerHarvester()
//             (see src/content/common.js) and close the tab.
//
// The 'tab' mode exists because Raider.IO, Guilds of WoW and the WarcraftLogs
// recruitment search all render their listings client-side — their HTML arrives
// empty, so there is nothing for DOMParser to read. Promoting any of them to
// 'fetch' later (once its JSON endpoint is known) means changing only the
// `mode` and `run` of that one entry; nothing downstream of the adapter cares.
//
// Every listing URL is user-editable in Settings → Scout. Sites move their
// listing pages; an officer should be able to paste the URL they actually use
// rather than wait for an extension update.

import { normalizeCandidate, passesWowProgressFilters, slugRealm } from './scout-core.js';

const FETCH_TIMEOUT_MS = 15_000;
const TAB_LOAD_TIMEOUT_MS = 25_000;

export const DEFAULT_SOURCE_URLS = {
    wowprogress:  'https://www.wowprogress.com/gearscore/?lfg=1&sortby=ts&raids_week=2&lang=en',
    raiderio:     'https://raider.io/search?recruitment.guild_raids.profile.published_at%5B0%5D%5Bgte%5D=1&sort%5Brecruitment.guild_raids.profile.published_at%5D=desc',
    guildsofwow:  'https://guildsofwow.com/recruits',
    warcraftlogs: 'https://www.warcraftlogs.com/recruitment/',
};

// Site enable flags — a source whose site is switched off still harvests, but
// that site's own filters never ran, so Scout warns the officer about it.
export const SITE_ENABLED_KEYS = {
    wowprogress:  'wowprogressEnabled',
    raiderio:     'raiderioEnabled',
    guildsofwow:  'guildsofwowEnabled',
    warcraftlogs: 'warcraftlogsEnabled',
};

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// ─── Tab harvesting ────────────────────────────────────────────────────────────

function waitForTabComplete(tabId, timeoutMs = TAB_LOAD_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out loading the page')); }, timeoutMs);

        function onUpdated(id, info) { if (id === tabId && info.status === 'complete') { cleanup(); resolve(); } }
        function onRemoved(id)       { if (id === tabId) { cleanup(); reject(new Error('Tab was closed before it loaded')); } }
        function cleanup() {
            clearTimeout(timer);
            chrome.tabs.onUpdated.removeListener(onUpdated);
            chrome.tabs.onRemoved.removeListener(onRemoved);
        }

        chrome.tabs.onUpdated.addListener(onUpdated);
        chrome.tabs.onRemoved.addListener(onRemoved);

        // The load may already have finished between create() and here.
        chrome.tabs.get(tabId, tab => {
            if (chrome.runtime.lastError) return;
            if (tab?.status === 'complete') { cleanup(); resolve(); }
        });
    });
}

// Content scripts register their harvester at document_start but the listing
// itself renders later, and some sites (WoWProgress, Raider.IO) self-redirect to
// add query params, which tears down the first content script. Retry rather
// than treating the first "no receiving end" as failure.
async function requestHarvest(tabId, sourceId, timeoutMs) {
    for (let attempt = 0; attempt < 5; attempt++) {
        const response = await new Promise(resolve => {
            chrome.tabs.sendMessage(
                tabId,
                { action: 'harvestCandidates', source: sourceId, timeoutMs },
                result => resolve(chrome.runtime.lastError ? null : result)
            );
        });
        if (response) return response;
        await delay(700);
    }
    return {
        ok: false, source: sourceId, candidates: [],
        error: 'The page loaded but its content script never answered. Reload the extension and try again.',
    };
}

async function harvestViaTab(sourceId, url, { timeoutMs = 15_000 } = {}) {
    let tabId = null;
    try {
        const tab = await chrome.tabs.create({ url, active: false });
        tabId = tab.id;
        await waitForTabComplete(tabId);
        const response = await requestHarvest(tabId, sourceId, timeoutMs);
        return { ...response, source: sourceId };
    } catch (err) {
        return { ok: false, source: sourceId, candidates: [], error: err?.message || String(err) };
    } finally {
        // Always clean up, including on timeout — a stranded background tab is
        // the one failure mode an officer would actually notice and resent.
        if (tabId !== null) chrome.tabs.remove(tabId).catch(() => {});
    }
}

// ─── WoWProgress: direct fetch + parse ─────────────────────────────────────────

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { signal: controller.signal, credentials: 'omit' });
    } catch (err) {
        if (err.name === 'AbortError') throw new Error(`Request timed out after ${timeoutMs / 1000}s`);
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

// Mirrors the selectors in src/content/wowprogress.js. They are duplicated
// rather than shared because content scripts are classic scripts with no export
// surface; if these two ever disagree, wowprogress.js is the reference.
const WOW_CLASS_NAMES = [
    'warrior', 'paladin', 'hunter', 'rogue', 'priest', 'shaman', 'mage',
    'warlock', 'monk', 'druid', 'deathknight', 'demon_hunter', 'evoker',
];

function rowClass(row) {
    const characterEl = row.querySelector('.character');
    for (const cls of characterEl?.classList || []) if (WOW_CLASS_NAMES.includes(cls)) return cls;
    for (const cls of row.classList)                if (WOW_CLASS_NAMES.includes(cls)) return cls;
    return null;
}

function rowRole(row) {
    const icon = row.querySelector('img[src*="spec_icon"], img[alt*="Healer"], img[alt*="Tank"]');
    const alt = (icon?.getAttribute('alt') || '').toLowerCase();
    if (!alt) return null;
    if (alt.includes('heal')) return 'healer';
    if (alt.includes('tank')) return 'tank';
    return 'dps';
}

export function parseWowProgressDocument(doc) {
    const rows = Array.from(doc.querySelectorAll('.rating tr')).slice(1);
    const raw = [];

    for (const row of rows) {
        const link = row.querySelector('a[href*="/character/"]');
        if (!link) continue;

        const parts = link.getAttribute('href').split('/').filter(Boolean);
        const idx = parts.indexOf('character');
        if (idx === -1 || parts.length < idx + 4) continue;

        const ilvlText = row.querySelector('td.center')?.textContent?.trim() ?? '';

        raw.push({
            region:      parts[idx + 1].toLowerCase(),
            realm:       slugRealm(parts[idx + 2]),
            name:        decodeURIComponent(parts[idx + 3].split('?')[0]),
            role:        rowRole(row),
            playerClass: rowClass(row),
            ilvl:        parseFloat(ilvlText),
            inGuild:     row.querySelector('.guild') !== null,
            note:        row.querySelector('.charnotes, .note')?.textContent?.trim() || null,
            link:        `https://www.wowprogress.com${link.getAttribute('href')}`,
        });
    }
    return raw;
}

async function harvestWowProgress(url, { pages = 1, filters = {} } = {}) {
    const collected = [];
    const warnings  = [];

    for (let page = 0; page < pages; page++) {
        const pageUrl = page === 0 ? url : appendPageParam(url, page);
        const response = await fetchWithTimeout(pageUrl);
        if (!response.ok) {
            if (page === 0) throw new Error(`WoWProgress returned HTTP ${response.status}`);
            warnings.push(`Page ${page + 1} returned HTTP ${response.status} — stopped paginating`);
            break;
        }

        const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
        if (!doc.querySelector('.rating')) {
            if (page === 0) {
                throw new Error('No results table (.rating) in the response — check the listing URL, ' +
                                'or WoWProgress changed its markup');
            }
            break;
        }

        const rows = parseWowProgressDocument(doc);
        if (rows.length === 0) break;   // ran past the last page
        collected.push(...rows);
    }

    // The tab-mode sources are filtered by their own content script before we
    // ever see them; this one has no content script, so apply the same filters
    // here to keep every source consistent.
    const filtered = collected.filter(row => {
        const candidate = normalizeCandidate(row, 'wowprogress');
        return candidate && passesWowProgressFilters({ ...candidate, inGuild: row.inGuild }, filters);
    });

    return { ok: true, source: 'wowprogress', url, candidates: filtered, warnings };
}

function appendPageParam(url, page) {
    const parsed = new URL(url);
    parsed.searchParams.set('next_page', String(page));
    return parsed.toString();
}

// ─── Adapter registry ──────────────────────────────────────────────────────────

export const SOURCE_ADAPTERS = [
    {
        id: 'wowprogress',
        mode: 'fetch',
        supportsPagination: true,
        run: (url, ctx) => harvestWowProgress(url, {
            pages: ctx.pagesPerSource,
            filters: {
                selectedRegions: (ctx.settings.selectedRegions ?? ['EU']).map(r => r.toLowerCase()),
                minIlvl:         parseFloat(ctx.settings.minIlvl) || 0,
                maxIlvl:         parseFloat(ctx.settings.maxIlvl) || 0,
                selectedClasses: ctx.settings.selectedClasses || [],
                guildFilter:     ctx.settings.guildFilter || 'any',
            },
        }),
    },
    { id: 'raiderio',     mode: 'tab', run: url => harvestViaTab('raiderio', url) },
    { id: 'guildsofwow',  mode: 'tab', run: url => harvestViaTab('guildsofwow', url) },
    { id: 'warcraftlogs', mode: 'tab', run: url => harvestViaTab('warcraftlogs', url, { timeoutMs: 18_000 }) },
];

export function adapterFor(sourceId) {
    return SOURCE_ADAPTERS.find(a => a.id === sourceId) || null;
}
