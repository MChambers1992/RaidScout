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
// The 'tab' mode exists because Raider.IO and Guilds of WoW both render their
// listings client-side — their HTML arrives empty, so there is nothing for
// DOMParser to read. Promoting either to 'fetch' later (once its JSON endpoint is
// known) means changing only the `mode` and `run` of that one entry; nothing
// downstream of the adapter cares.
//
// Every listing URL is user-editable in Settings → Scout. Sites move their
// listing pages; an officer should be able to paste the URL they actually use
// rather than wait for an extension update.

import { normalizeCandidate, passesWowProgressFilters, slugRealm } from './scout-core.js';

const FETCH_TIMEOUT_MS = 15_000;
const TAB_LOAD_TIMEOUT_MS = 25_000;

export const DEFAULT_SOURCE_URLS = {
    wowprogress:  'https://www.wowprogress.com/gearscore/?lfg=1&sortby=ts&raids_week=2&lang=en',
    // `type=character` is not optional: without it Raider.IO's advanced search
    // renders its table with an `.rt-noData` body and no rows at all, which
    // reached Scout as "no results rendered within 15s" and read like a markup
    // change or a sign-in wall. The recruitment filter and sort are what make it
    // a recruitment listing rather than a general character search.
    raiderio:     'https://raider.io/search?type=character&recruitment.guild_raids.profile.published_at%5B0%5D%5Bgte%5D=1&sort%5Brecruitment.guild_raids.profile.published_at%5D=desc',
    guildsofwow:  'https://guildsofwow.com/recruits',
};

// Site enable flags — a source whose site is switched off still harvests, but
// that site's own filters never ran, so Scout warns the officer about it.
export const SITE_ENABLED_KEYS = {
    wowprogress:  'wowprogressEnabled',
    raiderio:     'raiderioEnabled',
    guildsofwow:  'guildsofwowEnabled',
};

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// ─── Cloudflare ────────────────────────────────────────────────────────────────

// WoWProgress sits behind Cloudflare, and a challenged request is neither a bad
// listing URL nor changed markup — which is what the harvester used to report,
// sending the officer after the wrong problem entirely.
//
// Deliberately a small local copy of the idea in wcl-api.js rather than an
// import: that module is the service worker's API client, it carries the client
// secret's storage handling with it, and it reads a GraphQL response rather than
// an HTML page. Only the shape of the evidence is shared.
//
// `header` is a lookup fn so this stays pure and testable; response headers may
// not be readable in every context, so the body markers stand on their own.
export function isCloudflareChallenge({ status, header = () => '', body = '' } = {}) {
    if (header('cf-mitigated')) return true;
    if ((status === 403 || status === 503) && header('cf-ray')) return true;
    return /just a moment|cf-browser-verification|challenge-platform|__cf_chl/i.test(body || '');
}

// Thrown by the fetch harvester so the adapter can tell a challenge apart from a
// genuine failure and retry the listing in a real browser tab.
class CloudflareChallenge extends Error {
    constructor() {
        super('Cloudflare challenged the request');
        this.name = 'CloudflareChallenge';
    }
}

// ─── Tab harvesting ────────────────────────────────────────────────────────────

// Chrome refuses tabs.create/tabs.remove outright while the tab strip is busy —
// the user is mid-drag, or an animation from a tab this run just opened or
// closed has not settled — and the rejection reads "Tabs cannot be edited right
// now (user may be dragging a tab)". Scout is the one caller that opens and
// closes several tabs back to back, so it hits this far more often than the rest
// of the extension, and a source that never got its tab reports itself as a
// harvest failure with an error about tab dragging, which tells the officer
// nothing about recruitment.
//
// It is genuinely transient, so retry it and only it: any other tabs error is a
// real failure and is rethrown untouched.
const TAB_BUSY_RE = /cannot be edited right now|user may be dragging/i;

export async function withTabRetry(operation, { attempts = 6, baseDelayMs = 400 } = {}) {
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            return await operation();
        } catch (err) {
            if (!TAB_BUSY_RE.test(err?.message || '')) throw err;
            lastError = err;
            // Linear rather than exponential: a drag ends when the user lets go,
            // which is a human-scale wait, and backing off to 12s would outlast
            // the harvest timeout for no benefit.
            await delay(baseDelayMs * (attempt + 1));
        }
    }
    throw lastError || new Error('Tab could not be opened — the tab strip stayed busy');
}


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
// add query params, which tears down the first content script and discards the
// message in flight. Retry rather than treating the first "no receiving end" as
// failure.
//
// The retry budget is a wall-clock deadline, not a fixed attempt count. Five
// attempts 700ms apart gave up after 3.5s, which Raider.IO reliably outlasts: it
// rewrites its own query string to force the sort order, and the reload plus the
// SPA's first render takes longer than that — so a page that was going to work
// perfectly well was reported as "its content script never answered", and the
// suggested fix (reload the extension) had nothing to do with the cause.
const HARVEST_RETRY_WINDOW_MS = 12_000;

async function requestHarvest(tabId, sourceId, timeoutMs) {
    const deadline = Date.now() + HARVEST_RETRY_WINDOW_MS;
    let attempts = 0;

    while (true) {
        attempts++;
        const response = await new Promise(resolve => {
            chrome.tabs.sendMessage(
                tabId,
                { action: 'harvestCandidates', source: sourceId, timeoutMs },
                result => resolve(chrome.runtime.lastError ? null : result)
            );
        });
        if (response) return response;
        if (Date.now() >= deadline) break;
        await delay(600);
    }

    return {
        ok: false, source: sourceId, candidates: [],
        error: `The page never answered after ${attempts} attempts over ` +
               `${Math.round(HARVEST_RETRY_WINDOW_MS / 1000)}s. It may still have been loading or ` +
               `redirecting; if it happens every run, reload the extension at chrome://extensions.`,
    };
}

async function harvestViaTab(sourceId, url, { timeoutMs = 15_000 } = {}) {
    let tabId = null;
    try {
        const tab = await withTabRetry(() => chrome.tabs.create({ url, active: false }));
        tabId = tab.id;
        await waitForTabComplete(tabId);
        const response = await requestHarvest(tabId, sourceId, timeoutMs);
        return { ...response, source: sourceId };
    } catch (err) {
        return { ok: false, source: sourceId, candidates: [], error: err?.message || String(err) };
    } finally {
        // Always clean up, including on timeout — a stranded background tab is
        // the one failure mode an officer would actually notice and resent.
        if (tabId !== null) withTabRetry(() => chrome.tabs.remove(tabId)).catch(() => {});
    }
}

// ─── WoWProgress: direct fetch + parse ─────────────────────────────────────────

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        // credentials: 'include' rather than 'omit' so the cf_clearance cookie the
        // user earned by loading the site in a real tab rides along. Omitting it
        // made every harvest arrive as an unverified client, so Cloudflare
        // challenged the request no matter how recently they passed the check.
        // The cookies go only to the listing's own origin, which host_permissions
        // already covers. Whether the clearance cookie's SameSite attribute lets
        // it through from an extension page is not guaranteed — the tab fallback
        // below is what makes the challenge case actually recoverable.
        return await fetch(url, { signal: controller.signal, credentials: 'include' });
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

// The tab-mode sources are filtered by their own content script before we ever
// see them; the fetched listing has no content script, so apply the same filters
// here to keep every source consistent. The tab fallback below runs through this
// too — the content script will have filtered already and these criteria come
// from the same settings, so a second pass changes nothing, but it means the
// fallback still respects the officer's filters when the WoWProgress
// integration itself is switched off and no content-script pass ever ran.
function applyWowProgressFilters(rows, filters = {}) {
    return rows.filter(row => {
        const candidate = normalizeCandidate(row, 'wowprogress');
        return candidate && passesWowProgressFilters({ ...candidate, inGuild: row.inGuild }, filters);
    });
}

async function harvestWowProgress(url, { pages = 1, filters = {} } = {}) {
    const collected = [];
    const warnings  = [];

    for (let page = 0; page < pages; page++) {
        const pageUrl = page === 0 ? url : appendPageParam(url, page);
        const response = await fetchWithTimeout(pageUrl);
        const body = await response.text().catch(() => '');

        // Checked before response.ok: a challenge is usually a 403/503, and
        // reporting it as a plain HTTP error would hide the one cause the
        // officer can actually do something about.
        if (isCloudflareChallenge({ status: response.status, header: n => response.headers.get(n) || '', body })) {
            // Only the first page is worth falling back for. A challenge partway
            // through pagination still leaves the pages already collected, and
            // the tab fallback reads page one only — so it would hand back fewer
            // rows than we are already holding.
            if (page === 0) throw new CloudflareChallenge();
            warnings.push(`Page ${page + 1} was challenged by Cloudflare — stopped paginating`);
            break;
        }

        if (!response.ok) {
            if (page === 0) throw new Error(`WoWProgress returned HTTP ${response.status}`);
            warnings.push(`Page ${page + 1} returned HTTP ${response.status} — stopped paginating`);
            break;
        }

        const doc = new DOMParser().parseFromString(body, 'text/html');
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

    return { ok: true, source: 'wowprogress', url,
             candidates: applyWowProgressFilters(collected, filters), warnings };
}

// Fetch first — it is faster, needs no tab, and paginates. When Cloudflare
// challenges it, fall back to the same background-tab harvest the other three
// sources already use: the tab loads in the user's real browsing context, so a
// clearance they already hold applies and a JS challenge resolves itself, and
// wowprogress.js filters the rows exactly as it would for a human.
//
// This is the automated version of the manual step it replaces — opening
// wowprogress.com to clear Cloudflare before running a scout.
async function harvestWowProgressWithFallback(url, options) {
    try {
        return await harvestWowProgress(url, options);
    } catch (err) {
        if (err?.name !== 'CloudflareChallenge') throw err;

        // The content script is only injected on /gearscore/ (see the manifest),
        // so a listing repointed elsewhere has nothing to harvest it and would
        // just time out. Say why rather than making the officer wait for that.
        if (!/^\/gearscore\//.test(new URL(url).pathname)) {
            return {
                ok: false, source: 'wowprogress', url, candidates: [],
                error: 'Cloudflare challenged the request, and the background-tab fallback only works on ' +
                       'a /gearscore/ listing URL. Open wowprogress.com in a tab, complete the check, then re-run.',
            };
        }

        const viaTab = await harvestViaTab('wowprogress', url);
        const note = 'Cloudflare challenged the direct request, so the listing was harvested in a background ' +
                     'tab instead — slower, and first page only.';

        if (!viaTab.ok) {
            return {
                ...viaTab,
                url,
                error: `${note} That failed too: ${viaTab.error || 'unknown error'}. ` +
                       'Open wowprogress.com in a tab, complete the Cloudflare check, then re-run the scout.',
            };
        }
        return {
            ...viaTab,
            url,
            candidates: applyWowProgressFilters(viaTab.candidates || [], options?.filters),
            warnings: [...(viaTab.warnings || []), note],
        };
    }
}

function appendPageParam(url, page) {
    const parsed = new URL(url);
    parsed.searchParams.set('next_page', String(page));
    return parsed.toString();
}

// ─── Raider.IO listing URL ─────────────────────────────────────────────────────

// Raider.IO's advanced search needs `type=character` to return anything: without
// it the table renders with an empty `.rt-noData` body, which reaches Scout as
// "nothing rendered" and reads like a markup change or a sign-in wall. The
// default URL now carries it, but an officer who saved the old one in Settings →
// Scout would keep getting an empty harvest with no way to know why — and the
// listing-URL override exists precisely so they do not have to wait for an
// extension update. So repair it in passing rather than failing on it.
//
// Only the missing parameter is added; anything else the officer put in the URL
// is theirs and is left alone. An unparseable URL is handed back untouched for
// the harvester to fail on with its own message.
export function ensureRaiderioSearchParams(url) {
    try {
        const parsed = new URL(url);
        if (!parsed.pathname.startsWith('/search')) return url;
        if (parsed.searchParams.has('type')) return url;
        parsed.searchParams.set('type', 'character');
        return parsed.toString();
    } catch {
        return url;
    }
}

// ─── Adapter registry ──────────────────────────────────────────────────────────

export const SOURCE_ADAPTERS = [
    {
        id: 'wowprogress',
        mode: 'fetch',
        supportsPagination: true,
        run: (url, ctx) => harvestWowProgressWithFallback(url, {
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
    { id: 'raiderio',     mode: 'tab', run: url => harvestViaTab('raiderio', ensureRaiderioSearchParams(url)) },
    { id: 'guildsofwow',  mode: 'tab', run: url => harvestViaTab('guildsofwow', url) },
    // WarcraftLogs is not a source — see RETIRED_SOURCE_IDS in scout-core.js.
];

export function adapterFor(sourceId) {
    return SOURCE_ADAPTERS.find(a => a.id === sourceId) || null;
}
