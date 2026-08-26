// sources.js
// Source adapters for the Scout aggregator. Each adapter turns one recruitment
// site into a flat list of raw candidate rows, without the officer browsing there.
//
// Three harvest modes:
//
//   'fetch' — request the listing directly and parse it with DOMParser. Only
//             works for server-rendered listings; currently WoWProgress, which
//             falls back to 'tab' when Cloudflare refuses the request.
//
//   'api'   — read the site's own JSON endpoint. No tab, no cookies, real
//             pagination, and richer fields than the rendered page. Raider.IO.
//
//   'tab'   — open the listing in a hidden minimized window, let this extension's own
//             content script render *and filter* it exactly as it would for a
//             human, then ask it for the visible rows via registerHarvester()
//             (see src/content/common.js) and close the tab.
//
// 'tab' mode is the fallback of last resort, for listings that neither expose a
// JSON endpoint nor survive a cookieless fetch: Guilds of WoW and WoWProgress are
// server-rendered but Cloudflare-gated, and the WarcraftLogs recruitment search
// renders client-side behind a human check. Promoting a source out of 'tab'
// later means changing only the `mode` and `run` of that one entry; nothing
// downstream of the adapter cares.
//
// Every listing URL is user-editable in Settings → Scout. Sites move their
// listing pages; an officer should be able to paste the URL they actually use
// rather than wait for an extension update.

import {
    normalizeCandidate, passesWowProgressFilters, passesRaiderIoFilters, slugRealm,
} from './scout-core.js';

const FETCH_TIMEOUT_MS = 15_000;
const TAB_LOAD_TIMEOUT_MS = 25_000;

export const DEFAULT_SOURCE_URLS = {
    wowprogress:  'https://www.wowprogress.com/gearscore/?lfg=1&sortby=ts&raids_week=2&lang=en',
    raiderio:     'https://raider.io/search?type=character&recruitment.guild_raids.profile.published_at%5B0%5D%5Bgte%5D=1&sort%5Brecruitment.guild_raids.profile.published_at%5D=desc',
    guildsofwow:  'https://guildsofwow.com/recruits',
    // The two recruitment listings are named for who is *searching*, not who is
    // listed: "guild-looking-for-players" is the page a guild uses to find
    // players, so it is the one that lists characters. (The sibling
    // "player-looking-for-guilds" lists guilds, and harvesting it found nothing
    // — /recruitment/ itself is only a landing page.)
    warcraftlogs: 'https://www.warcraftlogs.com/recruitment/guild-looking-for-players',
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

// Harvest tabs open in their own minimized window rather than as a background
// tab in the officer's current window: no tab-strip flicker, no focus steal, and
// nothing to accidentally click into mid-harvest.
//
// Minimizing is safe *for these harvesters* specifically. Chrome throttles an
// occluded window — measured: requestAnimationFrame stops firing entirely — but
// the DOM still populates (GoW rendered 60 cards in 1.5s, WoWProgress 24 rows in
// 4.5s while minimized), and registerHarvester() only ever waits on a selector,
// never on an animation frame. A future source that needs a render loop must
// harvest visibly instead.
async function openHarvestWindow(url) {
    try {
        const win = await chrome.windows.create({ url, focused: false, state: 'minimized' });
        const tabId = win?.tabs?.[0]?.id ?? null;
        if (tabId !== null) return { tabId, windowId: win.id };
    } catch {
        // Fall through — some window managers refuse a minimized create.
    }
    const tab = await chrome.tabs.create({ url, active: false });
    return { tabId: tab.id, windowId: null };
}

// 30s, not 15: a Cloudflare JS check spends several seconds solving itself
// before the real page even begins loading, and the harvester now waits that
// out rather than failing on it. Measured worst case was ~4.5s to first row
// after the check cleared, so this leaves generous headroom.
const HARVEST_TIMEOUT_MS = 30_000;

async function harvestViaTab(sourceId, url, { timeoutMs = HARVEST_TIMEOUT_MS } = {}) {
    let tabId = null;
    let windowId = null;
    try {
        ({ tabId, windowId } = await openHarvestWindow(url));
        await waitForTabComplete(tabId);
        const response = await requestHarvest(tabId, sourceId, timeoutMs);
        return { ...response, source: sourceId };
    } catch (err) {
        return { ok: false, source: sourceId, candidates: [], error: err?.message || String(err) };
    } finally {
        // Always clean up, including on timeout — a stranded window is the one
        // failure mode an officer would actually notice and resent. Closing the
        // window takes its tab with it.
        if (windowId !== null)   chrome.windows.remove(windowId).catch(() => {});
        else if (tabId !== null) chrome.tabs.remove(tabId).catch(() => {});
    }
}

// ─── WoWProgress: direct fetch + parse ─────────────────────────────────────────

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        // WoWProgress sits behind Cloudflare, which 403s a cookieless request
        // outright — it can only issue its JS challenge to a real navigation.
        // Sending the browser's existing clearance cookie is what gets us a 200;
        // see the 403 branch in harvestWowProgress() for when it goes stale.
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

async function harvestWowProgress(url, { pages = 1, filters = {} } = {}) {
    const collected = [];
    const warnings  = [];

    for (let page = 0; page < pages; page++) {
        const pageUrl = page === 0 ? url : appendPageParam(url, page);
        const response = await fetchWithTimeout(pageUrl);
        if (!response.ok) {
            // 403 here is almost always Cloudflare: the clearance cookie this
            // request rides on has expired. Only a real navigation can renew it,
            // so say so rather than leaving the officer with a bare status code.
            if (page === 0 && response.status === 403) {
                throw new Error('WoWProgress returned HTTP 403 — its Cloudflare check has expired. ' +
                                'Open wowprogress.com in a tab once, then run Scout again.');
            }
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

// ─── Raider.IO: JSON API, no tab ───────────────────────────────────────────────
// The search page renders client-side, which is why this used to need a tab —
// but the page is itself driven by a public JSON endpoint that takes the very
// same query parameters, needs no cookies and no auth, pages with limit/offset,
// and returns richer data than the rendered table (authoritative spec role,
// exact ilvl, realm slug, avatar). So the tab is unnecessary: transform the
// officer's listing URL into the API call and read it directly.
const RAIDERIO_API      = 'https://raider.io/api/search-advanced';
const RAIDERIO_PAGE_MAX = 100;   // the endpoint's own per-request ceiling

export function raiderIoApiUrl(listingUrl, { limit = RAIDERIO_PAGE_MAX, offset = 0 } = {}) {
    const api = new URL(RAIDERIO_API);
    // Carry every filter the officer has in their listing URL across verbatim;
    // the endpoint speaks the same query language as the page.
    for (const [key, value] of new URL(listingUrl).searchParams) api.searchParams.set(key, value);
    // Without a type the endpoint ignores the recruitment.* filters entirely.
    if (api.searchParams.get('type') !== 'character') api.searchParams.set('type', 'character');
    api.searchParams.set('timezone', 'UTC');
    api.searchParams.set('limit',  String(Math.min(limit, RAIDERIO_PAGE_MAX)));
    api.searchParams.set('offset', String(offset));
    return api.toString();
}

// The API slugs classes with hyphens ("death-knight", "demon-hunter"); the rest
// of the extension keys them the way WoWProgress writes them in its classlist.
function classFromApiSlug(slug) {
    if (!slug) return null;
    const flat = String(slug).toLowerCase().replace(/[-\s]/g, '');
    if (flat === 'deathknight') return 'deathknight';
    if (flat === 'demonhunter') return 'demon_hunter';
    return flat;
}

export function parseRaiderIoMatches(json) {
    const rows = [];
    for (const match of json?.matches || []) {
        const d = match?.data;
        // region.slug is 'eu'/'us'; region.short_name is display text and varies
        // wildly ('OC', 'EU EN', 'US ES'), so it is never used for identity.
        const realm  = d?.realm?.slug;
        const region = d?.region?.slug;
        if (!d?.name || !realm || !region) continue;

        rows.push({
            region:      String(region).toLowerCase(),
            realm:       slugRealm(realm),
            name:        d.name,
            // spec.role is the site's own answer, so no spec-name inference here.
            role:        d.spec?.role || d.role || null,
            playerClass: classFromApiSlug(d.class?.slug),
            ilvl:        typeof d.itemLevelEquipped === 'number' ? d.itemLevelEquipped : null,
            inGuild:     !!d.guild?.name,
            guild:       d.guild?.name || null,
            spec:        d.spec?.name || null,
            // Protocol-relative in the payload.
            avatar:      d.thumbnailUrl ? `https:${String(d.thumbnailUrl).replace(/^https?:/, '')}` : null,
            link:        `https://raider.io/characters/${region}/${realm}/${encodeURIComponent(d.name)}`,
        });
    }
    return rows;
}

// ─── Role enrichment ───────────────────────────────────────────────────────────
// WoWProgress's LFG listing renders no spec or role information at all — no
// icons, no spec column — so every candidate it contributes arrives roleless and
// gets scored on the DPS metric, which quietly punishes healers. Raider.IO's
// public character-profile endpoint answers the question directly for any
// character, with no auth and no cookies, so a roleless candidate can simply be
// looked up rather than guessed at.
//
// One request per roleless candidate, so it only costs anything when a source
// could not report roles in the first place.
const RAIDERIO_PROFILE_API = 'https://raider.io/api/v1/characters/profile';

// Raider.IO words the role TANK / HEALING / DPS.
const PROFILE_ROLES = { TANK: 'tank', HEALING: 'healer', DPS: 'dps' };

export function roleFromProfileRole(value) {
    return PROFILE_ROLES[String(value ?? '').trim().toUpperCase()] ?? null;
}

// Returns null rather than throwing for every failure mode — an unknown
// character answers HTTP 400, and a roleless candidate is no worse off than
// before. Never let enrichment break a harvest that already succeeded.
export async function fetchCharacterProfile({ region, realm, name }) {
    if (!region || !realm || !name) return null;
    const url = new URL(RAIDERIO_PROFILE_API);
    url.searchParams.set('region', region);
    url.searchParams.set('realm', realm);
    url.searchParams.set('name', name);

    let response;
    try {
        response = await fetchWithTimeout(url.toString());
    } catch {
        return null;
    }
    if (!response.ok) return null;

    let json;
    try {
        json = await response.json();
    } catch {
        return null;
    }
    return {
        role:        roleFromProfileRole(json?.active_spec_role),
        spec:        json?.active_spec_name || null,
        // `class` is display text here ("Demon Hunter"), not the API slug.
        playerClass: classFromApiSlug(json?.class),
        avatar:      typeof json?.thumbnail_url === 'string' ? json.thumbnail_url : null,
    };
}

async function harvestRaiderIo(url, { pages = 1, filters = {} } = {}) {
    const collected = [];
    const warnings  = [];
    let total = null;

    for (let page = 0; page < pages; page++) {
        const apiUrl  = raiderIoApiUrl(url, { offset: page * RAIDERIO_PAGE_MAX });
        const response = await fetchWithTimeout(apiUrl);
        if (!response.ok) {
            if (page === 0) throw new Error(`Raider.IO API returned HTTP ${response.status}`);
            warnings.push(`page ${page + 1} returned HTTP ${response.status} — stopped paginating`);
            break;
        }

        const json = await response.json();
        if (total === null) total = json?.total?.value ?? null;

        const rows = parseRaiderIoMatches(json);
        if (rows.length === 0) break;      // ran past the last page
        collected.push(...rows);
        if (rows.length < RAIDERIO_PAGE_MAX) break;
    }

    // Reading the API instead of the rendered page means raiderio.js never ran,
    // so its filters have to be applied here — otherwise turning a filter on in
    // Settings would silently stop affecting Scout.
    const filtered = collected.filter(row =>
        passesRaiderIoFilters(normalizeCandidate(row, 'raiderio'), filters));

    if (total !== null && total > collected.length) {
        warnings.push(`${total} characters match this search; read ${collected.length}. ` +
                      `Raise “Pages per source” in Settings → Scout for more.`);
    }
    return { ok: true, source: 'raiderio', url, candidates: filtered, warnings };
}

// ─── Adapter registry ──────────────────────────────────────────────────────────

export const SOURCE_ADAPTERS = [
    {
        id: 'wowprogress',
        mode: 'fetch',
        supportsPagination: true,
        // Fetch is the fast path and the only one that can paginate, but
        // Cloudflare 403s it whenever the browser's clearance cookie is stale —
        // and only a real navigation can renew that. A background tab IS a real
        // navigation, so fall back to the same harvester the other three sites
        // use rather than returning nothing.
        run: async (url, ctx) => {
            try {
                return await harvestWowProgress(url, {
                    pages: ctx.pagesPerSource,
                    filters: {
                        selectedRegions: (ctx.settings.selectedRegions ?? ['EU']).map(r => r.toLowerCase()),
                        minIlvl:         parseFloat(ctx.settings.minIlvl) || 0,
                        maxIlvl:         parseFloat(ctx.settings.maxIlvl) || 0,
                        selectedClasses: ctx.settings.selectedClasses || [],
                        guildFilter:     ctx.settings.guildFilter || 'any',
                    },
                });
            } catch (err) {
                const viaTab = await harvestViaTab('wowprogress', url);
                // Report BOTH failures. Reporting only the fetch error made a
                // failed fallback look like it had never been attempted.
                if (!viaTab.ok) {
                    throw new Error(`${err?.message || err} A hidden tab was tried as a ` +
                                    `fallback and also failed: ${viaTab.error || 'unknown error'}`);
                }
                return {
                    ...viaTab,
                    warnings: [
                        ...(viaTab.warnings || []),
                        `reading the listing directly failed (${err?.message || err}), so it was ` +
                        `harvested in a background tab instead — only the first page was read.`,
                    ],
                };
            }
        },
    },
    {
        id: 'raiderio',
        mode: 'api',
        supportsPagination: true,
        run: (url, ctx) => harvestRaiderIo(url, {
            pages: ctx.pagesPerSource,
            filters: {
                selectedRegions: (ctx.settings.rioSelectedRegions || []).map(r => r.toLowerCase()),
                selectedRoles:   (ctx.settings.rioSelectedRoles   || []).map(r => r.toLowerCase()),
                selectedClasses: ctx.settings.rioSelectedClasses || [],
                minIlvl:         parseFloat(ctx.settings.rioMinIlvl) || 0,
            },
        }),
    },
    { id: 'guildsofwow',  mode: 'tab', run: url => harvestViaTab('guildsofwow', url) },
    { id: 'warcraftlogs', mode: 'tab', run: url => harvestViaTab('warcraftlogs', url) },
];

export function adapterFor(sourceId) {
    return SOURCE_ADAPTERS.find(a => a.id === sourceId) || null;
}
