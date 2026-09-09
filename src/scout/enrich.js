// enrich.js
// Cross-reference every harvested candidate against Raider.IO's public character
// API, so the table is filled in from one authoritative place rather than from
// whichever subset of stats the listing they happened to appear on published.
//
// Why this exists: the four listings report wildly different columns. WoWProgress
// rows carry an item level and nothing else — no M+ score, no raid progress.
// Raider.IO's search table publishes item level and role. Guilds of WoW is the
// only source that publishes all three. So a candidate's M+ and mythic columns
// read "—" not because the player has no score, but because the site that
// happened to list them does not print it, which is a fact about the website and
// tells an officer nothing about the recruit. Merging across sources only helps
// when the player was cross-posted; this fills the gaps for everyone.
//
// Raider.IO is the right source for it: the endpoint is public, unauthenticated,
// covers every region, and is the canonical home of the M+ score in the first
// place. host_permissions already includes raider.io, so these requests are not
// subject to CORS.
//
// Free of `chrome` and `document`, and `fetch` is injectable, so the parsing here
// is unit-tested directly (tests/enrich.test.js).

import { normalizeClassKey, roleFromClass } from './scout-core.js';

const RAIDERIO_PROFILE_URL = 'https://raider.io/api/v1/characters/profile';

// `gear` is by far the heaviest field (the full equipped item list), but it is
// also the only fresh item level available — a listing's ilvl is a snapshot from
// whenever the recruit posted, which may be weeks stale.
const PROFILE_FIELDS = 'gear,mythic_plus_scores_by_season:current,raid_progression';

const REQUEST_TIMEOUT_MS = 10_000;

export function buildProfileUrl({ region, realm, name }) {
    const url = new URL(RAIDERIO_PROFILE_URL);
    url.searchParams.set('region', String(region || '').toLowerCase());
    url.searchParams.set('realm', String(realm || ''));
    url.searchParams.set('name', String(name || ''));
    url.searchParams.set('fields', PROFILE_FIELDS);
    return url.toString();
}

// ─── Response parsing ──────────────────────────────────────────────────────────

// Raider.IO reports every raid of the expansion, keyed by slug, plus one or more
// `tier-*` aggregate entries. "Mythic kills" on every recruitment site means the
// current tier's main raid, so pick that: among the entries from the highest
// expansion the character has any progress in, the main raid is the one with the
// most bosses — single-boss world-boss style raids and the aggregates are never
// what an officer means.
//
// Returns the total as well as the kills, because "6" is not a readable answer
// and "6/8" is: a number on its own cannot be compared to anything, and the
// denominator changes every tier. Null rather than 0 when nothing can be
// identified — a missing stat and a zero are different answers, and Scout's
// filters only skip a minimum for the former (see quirk 36).
export function currentTierProgress(raidProgression) {
    if (!raidProgression || typeof raidProgression !== 'object') return null;

    const entries = Object.entries(raidProgression)
        .filter(([slug, raid]) => !slug.startsWith('tier-') && raid && typeof raid === 'object');
    if (entries.length === 0) return null;

    const latestExpansion = Math.max(...entries.map(([, raid]) => raid.expansion_id ?? 0));
    const [slug, raid] = entries
        .filter(([, r]) => (r.expansion_id ?? 0) === latestExpansion)
        // Object key order is insertion order, and Raider.IO lists raids oldest
        // first, so the later of two equally-sized raids is the newer one.
        .reduce((best, entry) =>
            (entry[1].total_bosses ?? 0) >= (best[1].total_bosses ?? 0) ? entry : best);

    const killed = raid.mythic_bosses_killed;
    if (!Number.isFinite(killed)) return null;

    const total = Number.isFinite(raid.total_bosses) && raid.total_bosses > 0 ? raid.total_bosses : null;
    return { killed, total, raid: slug };
}

// The current season's overall M+ score. `scores.all` is the headline number
// every site quotes; the per-role breakdown is not what a recruitment listing
// means by "M+ score".
export function currentMplusScore(scoresBySeason) {
    if (!Array.isArray(scoresBySeason) || scoresBySeason.length === 0) return null;
    const score = scoresBySeason[0]?.scores?.all;
    return Number.isFinite(score) ? score : null;
}

const RIO_ROLES = { dps: 'dps', healer: 'healer', healing: 'healer', tank: 'tank' };

// Raider.IO reports the role of the character's *currently active* spec. That is
// a real, first-hand answer — better than a listing's free-text claim — but it is
// a snapshot: an officer looking at a raider who logged out in their off-spec
// would see the wrong role. So it is only used where nothing better exists, and
// WarcraftLogs' resolved role (the spec they actually ranked as) still overrides
// it later during scoring.
function roleFromProfile(profile, playerClass) {
    const active = RIO_ROLES[String(profile.active_spec_role || '').toLowerCase()] || null;
    return roleFromClass(playerClass) || active;
}

// Turns a profile response into the candidate fields it can supply. Anything the
// response does not carry comes back null, never 0 or a guess.
export function profileToFields(profile) {
    if (!profile || typeof profile !== 'object' || profile.statusCode) return null;

    const playerClass = normalizeClassKey(profile.class);
    const ilvl = profile.gear?.item_level_equipped;
    const progress = currentTierProgress(profile.raid_progression);

    return {
        playerClass,
        role:        roleFromProfile(profile, playerClass),
        spec:        profile.active_spec_name || null,
        ilvl:        Number.isFinite(ilvl) && ilvl > 0 ? Math.round(ilvl * 10) / 10 : null,
        mplusScore:  currentMplusScore(profile.mythic_plus_scores_by_season),
        mythicKills: progress ? progress.killed : null,
        // The tier's boss count, so the table can say "6/8" rather than "6".
        mythicTotal: progress ? progress.total : null,
        mythicRaid:  progress ? progress.raid : null,
    };
}

// ─── Applying to a candidate ───────────────────────────────────────────────────

// Provenance marker for a field this module supplied. Deliberately not the plain
// 'raiderio' source id: that means "the recruit posted on Raider.IO's recruitment
// listing and it stated this", which is the recruit's own advert. This means "the
// Raider.IO character API reported it", which for a role is a snapshot of the spec
// they last logged out in — printable, but not something to score against, so
// scout.js queries those candidates with 'auto' instead.
//
// Safe as a value SOURCE_META does not know, because enrichment runs after all
// cross-source merging is finished and nothing compares origins by priority again.
export const ENRICH_ORIGIN = 'raiderio-api';

// Enrichment fills gaps and refreshes numbers; it never overwrites an identity a
// site stated. Numeric stats take the higher value for the same reason the
// cross-source merge does (scout-core.mergeCandidate): each reading is a snapshot
// from a different moment and gear, score and kills only go up, so the larger is
// the fresher. Class and role are only filled in where the listings left them
// unknown — a site that named a role saw the recruit's own advert, which beats an
// inference from whichever spec they last logged out in.
export function applyEnrichment(candidate, fields) {
    if (!fields) return candidate;

    const higher = (a, b) => {
        if (a === null || a === undefined) return b ?? null;
        if (b === null || b === undefined) return a;
        return Math.max(a, b);
    };

    const playerClass = candidate.playerClass || fields.playerClass || null;

    // Re-run the class inference before falling back to the API's role: a
    // candidate whose class was unknown until this lookup may be a mage, and that
    // settles the role outright. Tracked separately from the API's own answer
    // because the two carry very different confidence — an inference from a
    // DPS-only class cannot be wrong, so it keeps the harvest's provenance and
    // stays eligible for a single-metric score.
    const inferredRole = roleFromClass(playerClass);
    const role         = candidate.role || inferredRole || fields.role || null;

    let roleOrigin = candidate.origins?.role ?? null;
    if (!roleOrigin && role) {
        roleOrigin = inferredRole ? (candidate.origins?.playerClass ?? ENRICH_ORIGIN) : ENRICH_ORIGIN;
    }

    return {
        ...candidate,
        playerClass,
        role,
        spec:        candidate.spec || fields.spec || null,
        ilvl:        higher(candidate.ilvl, fields.ilvl),
        mplusScore:  higher(candidate.mplusScore, fields.mplusScore),
        mythicKills: higher(candidate.mythicKills, fields.mythicKills),
        // Not `higher`: the boss count is a property of the raid, identical for
        // everyone, so there is nothing to take the maximum of. Only Raider.IO
        // reports it, so this simply fills a blank.
        mythicTotal: candidate.mythicTotal ?? fields.mythicTotal ?? null,
        mythicRaid:  candidate.mythicRaid  ?? fields.mythicRaid  ?? null,
        origins: {
            ...candidate.origins,
            playerClass: candidate.origins?.playerClass || (fields.playerClass ? ENRICH_ORIGIN : null),
            role:        roleOrigin,
        },
        enriched: true,
    };
}

// ─── Fetching ──────────────────────────────────────────────────────────────────

async function fetchWithTimeout(url, fetchImpl, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetchImpl(url, { signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

// Fetches one candidate's profile. Never throws and never reports a problem
// upward: enrichment is additive, and a character Raider.IO has never seen (HTTP
// 400, "Could not find requested character") is the normal case for a fresh alt,
// not an error worth putting in front of an officer. A failed lookup simply
// leaves the candidate exactly as the listings described them.
export async function fetchProfileFields(candidate, { fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    try {
        const response = await fetchWithTimeout(buildProfileUrl(candidate), fetchImpl, timeoutMs);
        if (!response.ok) return null;
        return profileToFields(await response.json());
    } catch {
        return null;
    }
}
