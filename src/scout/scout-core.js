// scout-core.js
// Pure logic for the Scout aggregator: candidate normalisation, cross-source
// de-duplication/merging, sorting, filtering and CSV export.
//
// Deliberately free of `chrome`, `document` and `window` so it can be imported
// directly by Vitest (tests/scout-core.test.js) as well as by the Scout page.

// ─── Source metadata ───────────────────────────────────────────────────────────
// `priority` breaks ties when two sources disagree on a non-numeric field:
// lower wins. Ordering reflects how canonical each site's character identity is
// (WoWProgress/Raider.IO link to a real character page; GoW is reconstructed
// from a Blizzard render URL, so it is the least authoritative).

export const SOURCE_META = {
    wowprogress:  { label: 'WoWProgress',   colour: '#4a90d9', priority: 1 },
    raiderio:     { label: 'Raider.IO',     colour: '#00b35a', priority: 2 },
    guildsofwow:  { label: 'Guilds of WoW', colour: '#9B59B6', priority: 3 },
};

export const SOURCE_IDS = Object.keys(SOURCE_META);

// WarcraftLogs was harvested as a fourth source by opening its /recruitment/
// page in a background tab. It is no longer a source, for a reason that cannot
// be engineered around: WarcraftLogs sits behind an aggressive Cloudflare
// configuration, so the one source that most needed a tab was also the one most
// likely to be handed a challenge instead of a listing — which is the very cost
// pre-flight scouting exists to avoid paying.
//
// The obvious fix, asking their v2 API for the listing instead, is not available:
// the Client API's root Query exposes characterData, gameData, guildData,
// progressRaceData, rateLimitData, reportData, userData, worldData and two report
// component fields, and nothing across the whole published schema describes a
// recruitment post. (The recruitment feature's Discord integration is an outbound
// webhook — WarcraftLogs pushing new posts to a channel — not something a client
// can query.) So WarcraftLogs stays what it is best at and is still the most
// valuable thing here: the parse data every candidate is ranked by.
//
// Kept as an id so settings written by an older version — a stored scoutSources
// list, a saved source filter — are recognised and dropped rather than silently
// narrowing a filter to a source that can never match.
export const RETIRED_SOURCE_IDS = ['warcraftlogs'];

// ─── Identity ──────────────────────────────────────────────────────────────────

// Realms arrive in three shapes across the four sites: "Tarren Mill",
// "tarren-mill" and "Tarren-Mill", plus apostrophes ("Kil'jaeden"). Dedup only
// works if all of them collapse to one slug — this is what makes the same
// player posting on three sites become one row instead of three.
export function slugRealm(realm) {
    let value = String(realm || '').trim();

    // WoWProgress percent-encodes spaces in its character hrefs
    // ("/character/eu/Tarren%20Mill/…"), so without decoding first this yields
    // "tarren%20mill" and never matches Raider.IO's "tarren-mill" — every
    // multi-word realm would defeat de-duplication. decodeURIComponent throws
    // on a stray '%', so an undecodable value is used as-is.
    try { value = decodeURIComponent(value); } catch { /* keep raw */ }

    return value
        .toLowerCase()
        .replace(/['’]/g, '')
        .replace(/[\s_]+/g, '-')
        .replace(/-+/g, '-');
}

export function makeCandidateKey({ region, realm, name }) {
    return `${String(region || '').toLowerCase()}/${slugRealm(realm)}/${String(name || '').trim().toLowerCase()}`;
}

// ─── Display names ─────────────────────────────────────────────────────────────

// Storage uses lowercase underscore keys ('demon_hunter', 'deathknight').
// Naively replacing underscores gets 'demon hunter' right but leaves
// 'deathknight' as one word, so the two irregular names are spelled out.
const CLASS_KEYS = [
    'warrior', 'paladin', 'hunter', 'rogue', 'priest', 'shaman', 'mage',
    'warlock', 'monk', 'druid', 'deathknight', 'demon_hunter', 'evoker',
];

const CLASS_LABELS = {
    deathknight:  'Death Knight',
    demon_hunter: 'Demon Hunter',
};

export function classLabel(playerClass) {
    if (!playerClass) return null;
    if (CLASS_LABELS[playerClass]) return CLASS_LABELS[playerClass];
    return playerClass.charAt(0).toUpperCase() + playerClass.slice(1);
}

// The inverse: a display name from a site or an API ("Death Knight") back to the
// storage key. Mirrors normalizeClassName() in content/common.js, which cannot be
// imported here (classic script, no exports) — the two irregular names are the
// only reason either function exists.
export function normalizeClassKey(name) {
    if (!name) return null;
    const lower = String(name).toLowerCase().replace(/[\s_-]+/g, '');
    if (lower === 'deathknight')  return 'deathknight';
    if (lower === 'demonhunter')  return 'demon_hunter';
    return CLASS_KEYS.includes(lower) ? lower : null;
}

// Blizzard's official class icons, bundled under img/class/ so the table renders
// the same offline and makes no third-party request to draw a row. File names are
// the storage class keys, so this is a path join rather than a lookup table.
// Returns null for an unknown class — a row with no class shows no icon rather
// than a broken image.
export function classIconUrl(playerClass) {
    return CLASS_KEYS.includes(playerClass) ? `../../img/class/${playerClass}.jpg` : null;
}

// ─── Role inference ────────────────────────────────────────────────────────────

// Four classes have no tank or healer specialisation at all, so knowing the class
// settles the role outright — no markup reading, no API call, no guess. Every
// other class has at least one non-DPS spec, so its role stays unknown until a
// site says otherwise or WarcraftLogs resolves it from the spec they ranked as.
//
// This matters beyond the role column: a candidate with a known role is scored
// with a single-metric query instead of the heavier 'auto' lookup that fetches
// both DPS and HPS rankings, and it can never be mis-scored by a listing that
// advertised the wrong role.
export const DPS_ONLY_CLASSES = ['hunter', 'mage', 'rogue', 'warlock'];

export function roleFromClass(playerClass) {
    return DPS_ONLY_CLASSES.includes(playerClass) ? 'dps' : null;
}

// ─── Normalisation ─────────────────────────────────────────────────────────────

function num(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = typeof value === 'number' ? value : parseFloat(value);
    return Number.isFinite(n) ? n : null;
}

// Turn one raw scraped row into a canonical candidate. Returns null when the
// row lacks the identity needed to score it — a nameless row is not a lead.
export function normalizeCandidate(raw, source) {
    if (!raw) return null;
    const name   = String(raw.name || '').trim();
    const realm  = slugRealm(raw.realm);
    const region = String(raw.region || '').trim().toLowerCase();
    if (!name || !realm || !region) return null;

    // A class with no tank or healer spec settles its own role, so fill it in
    // where the listing did not. This is not the "default to dps" the comment
    // below warns about — a mage cannot be anything else — so it is safe to let
    // it win a merge, and it is recorded with the source that supplied the class.
    const playerClass = raw.playerClass || null;
    const role        = raw.role || roleFromClass(playerClass);

    return {
        key:         makeCandidateKey({ region, realm, name }),
        name,
        realm,
        region,
        // role is intentionally left null when unknown rather than defaulted to
        // 'dps' here: a null loses to a real role during merge, a fake 'dps'
        // would win and score a healer against a DPS threshold.
        role,
        playerClass,
        ilvl:        num(raw.ilvl),
        mythicKills: num(raw.mythicKills),
        // Bosses in the current tier. Only the Raider.IO cross-reference knows
        // it — the listings print a bare kill count — so it is usually filled in
        // later rather than harvested.
        mythicTotal: num(raw.mythicTotal),
        mplusScore:  num(raw.mplusScore),
        note:        raw.note ? String(raw.note).trim().slice(0, 300) : null,
        sources:     [source],
        // Which source supplied role/playerClass. Only meaningful once a
        // candidate has been merged, when `sources[0]` no longer identifies it.
        origins:     {
            role:        role        ? source : null,
            playerClass: playerClass ? source : null,
        },
        links:       raw.link ? { [source]: raw.link } : {},
        wcl:         null,
    };
}

// ─── Merge ─────────────────────────────────────────────────────────────────────

function preferHigher(a, b) {
    if (a === null || a === undefined) return b ?? null;
    if (b === null || b === undefined) return a;
    return Math.max(a, b);
}

// Picks between two values by source authority and reports which source the
// winner came from, so the merged candidate can remember it (see mergeCandidate).
// A null/undefined never wins over a real value, whatever its source ranks.
function preferByPriority(a, b, sourceA, sourceB) {
    const hasA = a !== null && a !== undefined;
    const hasB = b !== null && b !== undefined;
    if (!hasA && !hasB) return { value: null,  source: null };
    if (!hasA)          return { value: b,     source: sourceB };
    if (!hasB)          return { value: a,     source: sourceA };
    const pa = SOURCE_META[sourceA]?.priority ?? 99;
    const pb = SOURCE_META[sourceB]?.priority ?? 99;
    return pa <= pb ? { value: a, source: sourceA } : { value: b, source: sourceB };
}

// Merge `incoming` into `existing`, in place-safe fashion (returns a new object).
//
// Numeric stats take the HIGHER value: each site snapshots a character at a
// different time, and gear/progress only goes up, so the max is the freshest
// reading. Class/role take the more authoritative source (see SOURCE_META).
export function mergeCandidate(existing, incoming) {
    const incomingSource = incoming.sources[0];

    // Compare against the source that actually supplied each surviving value,
    // not existing.sources[0]. After an earlier merge the two differ: a
    // candidate first seen on WoWProgress with no role, then given one by
    // Guilds of WoW, still lists WoWProgress first — so comparing on
    // sources[0] would weigh a GoW role with WoWProgress's authority and let it
    // beat a Raider.IO role arriving next. `origins` carries that provenance.
    const originOf = (candidate, field) =>
        candidate.origins?.[field] ?? candidate.sources[0];

    const role        = preferByPriority(existing.role, incoming.role,
                                         originOf(existing, 'role'), originOf(incoming, 'role'));
    const playerClass = preferByPriority(existing.playerClass, incoming.playerClass,
                                         originOf(existing, 'playerClass'), originOf(incoming, 'playerClass'));

    return {
        ...existing,
        role:        role.value,
        playerClass: playerClass.value,
        origins:     { role: role.source, playerClass: playerClass.source },
        ilvl:        preferHigher(existing.ilvl, incoming.ilvl),
        mythicKills: preferHigher(existing.mythicKills, incoming.mythicKills),
        // Not preferHigher: the boss count describes the raid, not the player,
        // so there is no "freshest reading" to pick — first known value wins.
        mythicTotal: existing.mythicTotal ?? incoming.mythicTotal ?? null,
        mplusScore:  preferHigher(existing.mplusScore, incoming.mplusScore),
        note:        existing.note || incoming.note,
        sources:     existing.sources.includes(incomingSource)
                        ? existing.sources
                        : [...existing.sources, incomingSource],
        links:       { ...incoming.links, ...existing.links },
    };
}

// Collapse a flat list of candidates from every source into unique players.
// Preserves first-seen order so the harvest order (source order) is stable.
export function mergeCandidates(candidates) {
    const byKey = new Map();
    for (const candidate of candidates) {
        if (!candidate) continue;
        const existing = byKey.get(candidate.key);
        byKey.set(candidate.key, existing ? mergeCandidate(existing, candidate) : candidate);
    }
    return Array.from(byKey.values());
}

// Mythic progress as an officer reads it. A bare "6" says nothing without the
// tier's boss count — 6/8 is most of a tier, 6/12 is a third of one, and the
// denominator changes with every raid. Falls back to the bare number when only a
// listing supplied the kills and nothing supplied the total.
export function formatMythicProgress(candidate) {
    const killed = candidate?.mythicKills;
    if (killed === null || killed === undefined) return null;
    const total = candidate.mythicTotal;
    return total ? `${killed}/${total}` : String(killed);
}

// ─── Score classification ──────────────────────────────────────────────────────

// True when WarcraftLogs gave a definitive answer that this character has no
// logs — as opposed to a lookup that failed or never ran.
//
// The distinction carries the whole no-logs filtering rule: `notFound` (or a
// successful lookup with both metrics null) is real information about the
// candidate, so Scout can act on it. An `error` is information about the
// *request*, not the player, so it must never remove anyone.
export function hasNoLogs(score) {
    if (!score || score.error) return false;
    return !!score.notFound || (score.best === null && score.median === null);
}

// Whether a score was actually obtained (used to tell "we know they're empty"
// apart from "we never asked").
export function isScored(score) {
    return !!score && !score.error;
}

// ─── Score error reporting ─────────────────────────────────────────────────────

// Turns a raw scoring error into something an officer can act on.
//
// Scoring failures fail *open* — an unscored candidate is never hidden — which is
// right, but it meant a lookup failing for every single candidate produced a
// table of identical "⚠ WCL err" badges and no explanation anywhere except each
// badge's hover tooltip. That is precisely the silent-wrong-result Scout's
// fail-visible rule exists to prevent (quirk 23), just applied to scoring instead
// of harvesting.
//
// Returns { headline, hint } — hint is null when the raw message is already the
// most specific thing we can say.
export function describeScoreError(message) {
    const raw = String(message || 'UNKNOWN_ERROR');

    if (raw === 'NO_CREDENTIALS') return {
        headline: 'No WarcraftLogs API credentials',
        hint: 'Add a Client ID and Secret in Settings → WarcraftLogs.',
    };
    if (raw === 'NO_RESPONSE') return {
        headline: 'The background service worker did not answer',
        hint: 'Chrome may have shut it down mid-run. Re-run the scout; if it keeps happening, ' +
              'reload the extension at chrome://extensions and check its service-worker console.',
    };
    if (raw === 'FETCH_TIMEOUT') return {
        headline: 'WarcraftLogs did not respond in time',
        hint: 'Usually a slow connection or a WarcraftLogs outage. Re-run to retry — nothing was cached.',
    };
    if (raw.startsWith('RATE_LIMITED')) return {
        headline: 'WarcraftLogs rate limit',
        hint: 'Wait for the cooldown and re-run; cached scores make the re-run cheap.',
    };
    if (raw.startsWith('CLOUDFLARE_BLOCKED')) return {
        headline: 'Cloudflare is challenging API requests',
        hint: 'Open warcraftlogs.com in a normal tab and complete the check, then re-run.',
    };
    if (raw.startsWith('WCL token request failed')) return {
        headline: raw,
        // A 401 here is the credentials themselves; anything else is the token
        // endpoint, which is a different problem with a different fix.
        hint: raw.includes('(401)') || raw.includes('(403)')
            ? 'The Client ID or Secret is wrong or has been revoked. Re-enter them in ' +
              'Settings → WarcraftLogs and use Test connection.'
            : 'The WarcraftLogs OAuth endpoint rejected the request. Try Test connection in ' +
              'Settings → WarcraftLogs to see the full response.',
    };
    if (raw.startsWith('WCL GraphQL error')) return {
        headline: raw,
        hint: 'WarcraftLogs accepted the request but rejected the query, which usually means their ' +
              'API schema changed. This needs an extension fix — please report the message above.',
    };
    if (raw.startsWith('WCL query failed')) return {
        headline: raw,
        hint: 'WarcraftLogs returned an HTTP error for the query itself.',
    };
    return { headline: raw, hint: null };
}

// Groups the scored candidates by failure so one banner line can stand in for
// every row that failed the same way, rather than one line per candidate.
export function summarizeScoreErrors(candidates) {
    const counts = new Map();
    for (const candidate of candidates) {
        const error = candidate?.wcl?.error;
        if (!error) continue;
        counts.set(error, (counts.get(error) || 0) + 1);
    }
    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([message, count]) => ({ message, count, ...describeScoreError(message) }));
}

// ─── Filtering ─────────────────────────────────────────────────────────────────

// Applies the WoWProgress-tab filters to a candidate. Used by the fetch adapter,
// which parses raw HTML and therefore has no content script to filter for it.
// Mirrors filterPlayers() in src/content/wowprogress.js — a null field always
// passes, matching the "never hide on missing data" rule used site-side.
export function passesWowProgressFilters(candidate, settings = {}) {
    const {
        selectedRegions = [], minIlvl = 0, maxIlvl = 0,
        selectedClasses = [], guildFilter = 'any',
    } = settings;

    if (selectedRegions.length && candidate.region &&
        !selectedRegions.some(r => r.toLowerCase() === candidate.region)) return false;

    if (candidate.ilvl !== null) {
        if (minIlvl > 0 && candidate.ilvl < minIlvl) return false;
        if (maxIlvl > 0 && candidate.ilvl > maxIlvl) return false;
    }

    if (selectedClasses.length && candidate.playerClass &&
        !selectedClasses.includes(candidate.playerClass)) return false;

    if (guildFilter === 'in'  && candidate.inGuild === false) return false;
    if (guildFilter === 'out' && candidate.inGuild === true)  return false;

    return true;
}

// ─── Sorting ───────────────────────────────────────────────────────────────────

const SORT_ACCESSORS = {
    name:        c => c.name?.toLowerCase() ?? '',
    realm:       c => c.realm ?? '',
    region:      c => c.region ?? '',
    playerClass: c => c.playerClass ?? '',
    role:        c => c.role ?? '',
    ilvl:        c => c.ilvl,
    mythicKills: c => c.mythicKills,
    mplusScore:  c => c.mplusScore,
    wclBest:     c => c.wcl?.best ?? null,
    wclMedian:   c => c.wcl?.median ?? null,
    sources:     c => c.sources.length,
};

// Sorts a copy. Missing values always sort last regardless of direction — an
// unscored row sinking to the bottom is far more useful to an officer than it
// jumping to the top on an ascending sort.
export function sortCandidates(candidates, key, direction = 'desc') {
    const accessor = SORT_ACCESSORS[key];
    if (!accessor) return [...candidates];
    const sign = direction === 'asc' ? 1 : -1;

    return [...candidates].sort((a, b) => {
        const av = accessor(a);
        const bv = accessor(b);
        const aMissing = av === null || av === undefined || av === '';
        const bMissing = bv === null || bv === undefined || bv === '';
        if (aMissing && bMissing) return 0;
        if (aMissing) return 1;
        if (bMissing) return -1;
        if (typeof av === 'string' || typeof bv === 'string') {
            return String(av).localeCompare(String(bv)) * sign;
        }
        return (av - bv) * sign;
    });
}

// ─── Text search ───────────────────────────────────────────────────────────────

export function matchesQuery(candidate, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return true;
    return [candidate.name, candidate.realm, candidate.region, candidate.playerClass, candidate.role, candidate.note]
        .some(field => field && String(field).toLowerCase().includes(q));
}

// ─── Profile links ─────────────────────────────────────────────────────────────

// ─── Structured filters ────────────────────────────────────────────────────────
// The search box answers "where is Thrall"; these answer "who is worth talking
// to". Kept here, pure and testable, rather than inline in the page: they decide
// what an officer does and does not see, which is exactly the logic that should
// not live only in an event handler.
//
// Every field is opt-in — an empty list or a zero minimum means "no opinion" —
// so the default shape hides nobody. That matters because these persist: a
// filter an officer set weeks ago is still applied on their next run, and one
// that silently excluded everyone would look like a broken harvest.

export const DEFAULT_FILTERS = {
    roles:       [],   // 'tank' | 'healer' | 'dps'
    classes:     [],   // storage class names, e.g. 'demon_hunter'
    regions:     [],   // lowercase, e.g. 'eu'
    sources:     [],   // SOURCE_IDS
    minIlvl:     0,
    minMplus:    0,
    minMythic:   0,
    multiSource: false,
};

// Coerces whatever came back from storage into the shape the filter expects.
// Stored settings outlive the code that wrote them: a key that has since changed
// type, or a list that arrived as a string, must not throw during a render.
export function normalizeFilters(raw) {
    const list = (value) => (Array.isArray(value) ? value.filter(v => typeof v === 'string' && v) : []);
    const num  = (value) => {
        const n = typeof value === 'number' ? value : parseFloat(value);
        return Number.isFinite(n) && n > 0 ? n : 0;
    };
    const input = raw && typeof raw === 'object' ? raw : {};
    return {
        roles:       list(input.roles).map(r => r.toLowerCase()),
        classes:     list(input.classes),
        regions:     list(input.regions).map(r => r.toLowerCase()),
        // A source that no longer exists is dropped, not kept: a stored filter
        // naming only WarcraftLogs would otherwise match nothing at all and read
        // as a harvest that found nobody.
        sources:     list(input.sources).filter(id => SOURCE_IDS.includes(id)),
        minIlvl:     num(input.minIlvl),
        minMplus:    num(input.minMplus),
        minMythic:   num(input.minMythic),
        multiSource: input.multiSource === true,
    };
}

// How many filters are actually narrowing the list — drives the count on the
// Filters button, so an officer can tell at a glance that a short list is their
// own doing rather than a bad harvest.
export function activeFilterCount(filters) {
    const f = normalizeFilters(filters);
    return f.roles.length + f.classes.length + f.regions.length + f.sources.length
         + (f.minIlvl   > 0 ? 1 : 0)
         + (f.minMplus  > 0 ? 1 : 0)
         + (f.minMythic > 0 ? 1 : 0)
         + (f.multiSource ? 1 : 0);
}

export function hasActiveFilters(filters) {
    return activeFilterCount(filters) > 0;
}

// A missing value never fails a minimum. Sites report different subsets — a
// WoWProgress row carries no M+ score at all — so treating absent as zero would
// quietly drop every candidate from the sites that do not publish that stat,
// which is the same trap the site-side filters avoid (quirk 6).
function passesMinimum(value, minimum) {
    if (!(minimum > 0)) return true;
    return value === null || value === undefined || value >= minimum;
}

export function matchesFilters(candidate, filters) {
    if (!candidate) return false;
    const f = normalizeFilters(filters);

    if (f.roles.length   && !(candidate.role        && f.roles.includes(candidate.role))) return false;
    if (f.classes.length && !(candidate.playerClass && f.classes.includes(candidate.playerClass))) return false;
    if (f.regions.length && !(candidate.region      && f.regions.includes(String(candidate.region).toLowerCase()))) return false;

    if (f.sources.length) {
        const seen = Array.isArray(candidate.sources) ? candidate.sources : [];
        if (!seen.some(source => f.sources.includes(source))) return false;
    }

    if (f.multiSource && !(Array.isArray(candidate.sources) && candidate.sources.length > 1)) return false;

    if (!passesMinimum(candidate.ilvl,        f.minIlvl))   return false;
    if (!passesMinimum(candidate.mplusScore,  f.minMplus))  return false;
    if (!passesMinimum(candidate.mythicKills, f.minMythic)) return false;

    return true;
}

export function profileLinks(candidate) {
    const { region, realm, name } = candidate;
    return {
        ...candidate.links,
        warcraftlogs: `https://www.warcraftlogs.com/character/${region}/${realm}/${encodeURIComponent(name)}`,
        raiderio:     candidate.links.raiderio ||
                      `https://raider.io/characters/${region}/${realm}/${encodeURIComponent(name)}`,
    };
}

// ─── Export ────────────────────────────────────────────────────────────────────

const CSV_COLUMNS = [
    ['name',        c => c.name],
    ['realm',       c => c.realm],
    ['region',      c => c.region],
    ['class',       c => c.playerClass],
    ['role',        c => c.role],
    ['ilvl',        c => c.ilvl],
    ['mythic_kills', c => c.mythicKills],
    ['mythic_total', c => c.mythicTotal],
    ['mplus_score', c => c.mplusScore],
    ['wcl_best',    c => c.wcl?.best],
    ['wcl_median',  c => c.wcl?.median],
    ['sources',     c => c.sources.join(' ')],
    ['note',        c => c.note],
    ['warcraftlogs_url', c => profileLinks(c).warcraftlogs],
];

function csvCell(value) {
    if (value === null || value === undefined) return '';
    const str = String(value);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

export function toCsv(candidates) {
    const header = CSV_COLUMNS.map(([name]) => name).join(',');
    const rows = candidates.map(c => CSV_COLUMNS.map(([, get]) => csvCell(get(c))).join(','));
    return [header, ...rows].join('\n');
}

// In-game whisper lists want Name-Realm, which is what the WoW client accepts
// for a cross-realm whisper. Realm slugs are de-slugified back to PascalCase.
export function toWhisperList(candidates) {
    return candidates
        .map(c => `${c.name}-${c.realm.split('-').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('')}`)
        .join('\n');
}

// ─── Concurrency ───────────────────────────────────────────────────────────────
// Same pool as common.js runWithConcurrency, re-exported here so the Scout page
// and the tests can use it without depending on a content-script global.

export async function runWithConcurrency(items, worker, limit = 4) {
    const queue = [...items];
    const runners = [];
    for (let i = 0; i < Math.min(limit, queue.length); i++) {
        runners.push((async () => {
            while (queue.length) await worker(queue.shift());
        })());
    }
    await Promise.all(runners);
}
