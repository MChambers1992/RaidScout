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

// `abbr` is what the Scout table shows per row. Bare coloured dots needed a
// tooltip to mean anything; a two- or three-letter brand-coloured pill is
// readable at a glance without one.
export const SOURCE_META = {
    wowprogress:  { label: 'WoWProgress',   abbr: 'WP',  colour: '#4a90d9', priority: 1 },
    raiderio:     { label: 'Raider.IO',     abbr: 'RIO', colour: '#00b35a', priority: 2 },
    warcraftlogs: { label: 'WarcraftLogs',  abbr: 'WCL', colour: '#e8670d', priority: 3 },
    guildsofwow:  { label: 'Guilds of WoW', abbr: 'GoW', colour: '#9B59B6', priority: 4 },
};

export const SOURCE_IDS = Object.keys(SOURCE_META);

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
const CLASS_LABELS = {
    deathknight:  'Death Knight',
    demon_hunter: 'Demon Hunter',
};

export function classLabel(playerClass) {
    if (!playerClass) return null;
    if (CLASS_LABELS[playerClass]) return CLASS_LABELS[playerClass];
    return playerClass.charAt(0).toUpperCase() + playerClass.slice(1);
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

    return {
        key:         makeCandidateKey({ region, realm, name }),
        name,
        realm,
        region,
        // role is intentionally left null when unknown rather than defaulted to
        // 'dps' here: a null loses to a real role during merge, a fake 'dps'
        // would win and score a healer against a DPS threshold.
        role:        raw.role || null,
        playerClass: raw.playerClass || null,
        ilvl:        num(raw.ilvl),
        mythicKills: num(raw.mythicKills),
        mplusScore:  num(raw.mplusScore),
        note:        raw.note ? String(raw.note).trim().slice(0, 300) : null,
        // Present only where a source actually publishes them: Raider.IO's API
        // returns a spec name, current guild and Blizzard avatar URL, none of
        // which the scraped listings expose. Kept optional rather than required
        // so a source that lacks them still produces a valid candidate.
        spec:        raw.spec ? String(raw.spec).trim() : null,
        guild:       raw.guild ? String(raw.guild).trim() : null,
        avatar:      typeof raw.avatar === 'string' && raw.avatar.startsWith('https://')
                        ? raw.avatar : null,
        sources:     [source],
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

function preferByPriority(a, b, sourceA, sourceB) {
    if (a === null || a === undefined) return b ?? null;
    if (b === null || b === undefined) return a;
    const pa = SOURCE_META[sourceA]?.priority ?? 99;
    const pb = SOURCE_META[sourceB]?.priority ?? 99;
    return pa <= pb ? a : b;
}

// Merge `incoming` into `existing`, in place-safe fashion (returns a new object).
//
// Numeric stats take the HIGHER value: each site snapshots a character at a
// different time, and gear/progress only goes up, so the max is the freshest
// reading. Class/role take the more authoritative source (see SOURCE_META).
export function mergeCandidate(existing, incoming) {
    const primarySource  = existing.sources[0];
    const incomingSource = incoming.sources[0];

    return {
        ...existing,
        role:        preferByPriority(existing.role, incoming.role, primarySource, incomingSource),
        playerClass: preferByPriority(existing.playerClass, incoming.playerClass, primarySource, incomingSource),
        ilvl:        preferHigher(existing.ilvl, incoming.ilvl),
        mythicKills: preferHigher(existing.mythicKills, incoming.mythicKills),
        mplusScore:  preferHigher(existing.mplusScore, incoming.mplusScore),
        note:        existing.note || incoming.note,
        // First non-null wins for these: they are descriptive, not measurements,
        // so there is no "higher is fresher" argument to make.
        spec:        existing.spec   || incoming.spec,
        guild:       existing.guild  || incoming.guild,
        avatar:      existing.avatar || incoming.avatar,
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

// Raider.IO's equivalent. Scout reads Raider.IO through its JSON API rather
// than a rendered page, so raiderio.js never runs and its filters have to be
// applied here instead — see the adapter in sources.js.
//
// Same fail-open contract as the WoWProgress version above: a filter only ever
// excludes a candidate whose value is actually known. An unknown class or ilvl
// keeps the row, because dropping a lead over missing data is the worse error.
export function passesRaiderIoFilters(candidate, settings = {}) {
    if (!candidate) return false;
    const {
        selectedRegions = [], selectedRoles = [], selectedClasses = [], minIlvl = 0,
    } = settings;

    if (selectedRegions.length && candidate.region &&
        !selectedRegions.some(r => r.toLowerCase() === candidate.region)) return false;

    if (selectedRoles.length && candidate.role &&
        !selectedRoles.some(r => r.toLowerCase() === candidate.role)) return false;

    if (selectedClasses.length && candidate.playerClass &&
        !selectedClasses.includes(candidate.playerClass)) return false;

    if (minIlvl > 0 && candidate.ilvl !== null && candidate.ilvl < minIlvl) return false;

    return true;
}

// Scout's own filters, applied to the merged list rather than to any one site.
//
// Every source filters differently — WoWProgress by its table, Raider.IO by its
// API query, GoW by its cards — so the merged list was only ever as strict as
// the loosest source. These run over candidates after the merge, which also
// means toggling one re-filters instantly instead of re-harvesting.
//
// DELIBERATELY STRICTER than the per-site filters: here an unknown value is
// excluded when a minimum is set, because by this point the candidate has been
// scored and merged from every source that had it, so a missing item level
// really means "nobody published one" rather than "this source doesn't say".
// `hideUnknown: false` restores the per-site fail-open behaviour.
export function passesScoutFilters(candidate, settings = {}) {
    if (!candidate) return false;
    const {
        classes = [], roles = [], regions = [],
        minIlvl = 0, minMplus = 0, minMythicKills = 0,
        minBestParse = 0, minMedianParse = 0,
        guild = 'any', hideUnknown = false,
    } = settings;

    if (regions.length && !regions.includes(candidate.region)) return false;
    if (roles.length   && !(candidate.role && roles.includes(candidate.role))) return false;
    if (classes.length && !(candidate.playerClass && classes.includes(candidate.playerClass))) return false;

    const atLeast = (value, min) => {
        if (min <= 0) return true;
        if (value === null || value === undefined) return !hideUnknown;
        return value >= min;
    };

    if (!atLeast(candidate.ilvl,        minIlvl))        return false;
    if (!atLeast(candidate.mplusScore,  minMplus))       return false;
    if (!atLeast(candidate.mythicKills, minMythicKills)) return false;

    // Parses come from the WCL layer, which may not have run at all; an unscored
    // candidate is never excluded by a parse minimum unless hideUnknown is set.
    if (minBestParse > 0 || minMedianParse > 0) {
        if (!candidate.wcl || candidate.wcl.error) { if (hideUnknown) return false; }
        else {
            if (!atLeast(candidate.wcl.best,   minBestParse))   return false;
            if (!atLeast(candidate.wcl.median, minMedianParse)) return false;
        }
    }

    if (guild === 'in'  && candidate.guild === null) return false;
    if (guild === 'out' && candidate.guild !== null) return false;

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
