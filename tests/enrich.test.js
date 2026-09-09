// tests/enrich.test.js
// Unit tests for the Raider.IO cross-reference. The parsing here decides what an
// officer sees in the M+, mythic and item-level columns for candidates whose own
// listing never published those numbers, so it is worth pinning down — especially
// the "absent is not zero" rule, which Scout's minimum filters depend on
// (a stat treated as 0 would drop the candidate from every filtered view).

import { describe, it, expect } from 'vitest';
import {
    buildProfileUrl, currentTierProgress, currentMplusScore,
    profileToFields, applyEnrichment, fetchProfileFields, ENRICH_ORIGIN,
} from '../src/scout/enrich.js';

// Shaped like a real response, trimmed to the fields the module reads.
const profile = (over = {}) => ({
    name: 'Thrall',
    class: 'Shaman',
    active_spec_name: 'Elemental',
    active_spec_role: 'DPS',
    gear: { item_level_equipped: 627.375 },
    mythic_plus_scores_by_season: [{ season: 'season-mn-2', scores: { all: 3102.1, dps: 3102.1 } }],
    raid_progression: {
        'the-tidebound-grotto': { expansion_id: 11, total_bosses: 1, mythic_bosses_killed: 1 },
        'the-venomous-abyss':   { expansion_id: 11, total_bosses: 8, mythic_bosses_killed: 6 },
        'tier-mn-1':            { expansion_id: 11, total_bosses: 9, mythic_bosses_killed: 9 },
    },
    ...over,
});

const candidate = (over = {}) => ({
    key: 'eu/tarren-mill/thrall', name: 'Thrall', realm: 'tarren-mill', region: 'eu',
    role: null, playerClass: null, ilvl: null, mplusScore: null, mythicKills: null,
    sources: ['wowprogress'], origins: { role: null, playerClass: null }, links: {}, wcl: null,
    ...over,
});

describe('buildProfileUrl', () => {
    it('sends the identity Scout already normalised', () => {
        const url = new URL(buildProfileUrl({ region: 'EU', realm: 'tarren-mill', name: 'Thrall' }));
        expect(url.origin + url.pathname).toBe('https://raider.io/api/v1/characters/profile');
        expect(url.searchParams.get('region')).toBe('eu');
        expect(url.searchParams.get('realm')).toBe('tarren-mill');
        expect(url.searchParams.get('name')).toBe('Thrall');
        expect(url.searchParams.get('fields')).toContain('raid_progression');
    });

    it('escapes names rather than breaking the query string', () => {
        const url = new URL(buildProfileUrl({ region: 'eu', realm: 'kiljaeden', name: 'Ünstöppable' }));
        expect(url.searchParams.get('name')).toBe('Ünstöppable');
    });
});

describe('currentTierProgress', () => {
    it('reads the main raid of the newest tier, not a one-boss raid', () => {
        // 8-boss raid over the 1-boss one: "mythic kills" on every recruitment
        // site means the tier's main raid.
        expect(currentTierProgress(profile().raid_progression))
            .toEqual({ killed: 6, total: 8, raid: 'the-venomous-abyss' });
    });

    it('ignores the tier-* aggregate entries', () => {
        // tier-mn-1 has the most bosses (9) and would win on size alone.
        expect(currentTierProgress(profile().raid_progression).raid).not.toBe('tier-mn-1');
    });

    it('prefers the newest expansion over a bigger older raid', () => {
        expect(currentTierProgress({
            'old-huge-raid': { expansion_id: 10, total_bosses: 12, mythic_bosses_killed: 12 },
            'new-raid':      { expansion_id: 11, total_bosses: 8,  mythic_bosses_killed: 2 },
        })).toMatchObject({ killed: 2, total: 8 });
    });

    it('returns the boss count so the table can render 6/8 rather than 6', () => {
        // A kill count with no denominator cannot be compared to anything, and
        // the denominator changes every tier.
        expect(currentTierProgress(profile().raid_progression).total).toBe(8);
    });

    it('returns null rather than 0 when there is nothing to read', () => {
        // A minimum filter skips a null but rejects a 0, so this distinction is
        // what keeps an unreported stat from hiding the candidate.
        expect(currentTierProgress(null)).toBeNull();
        expect(currentTierProgress({})).toBeNull();
        expect(currentTierProgress({ 'tier-mn-1': { expansion_id: 11, total_bosses: 9 } })).toBeNull();
    });

    it('keeps a real zero, which is a genuine answer', () => {
        expect(currentTierProgress({
            'new-raid': { expansion_id: 11, total_bosses: 8, mythic_bosses_killed: 0 },
        })).toMatchObject({ killed: 0, total: 8 });
    });

    it('leaves the total null when the raid does not report one', () => {
        expect(currentTierProgress({
            'new-raid': { expansion_id: 11, mythic_bosses_killed: 3 },
        })).toMatchObject({ killed: 3, total: null });
    });
});

describe('currentMplusScore', () => {
    it('takes the current season overall score', () => {
        expect(currentMplusScore(profile().mythic_plus_scores_by_season)).toBe(3102.1);
    });

    it('is null when the season array is empty or malformed', () => {
        expect(currentMplusScore([])).toBeNull();
        expect(currentMplusScore(undefined)).toBeNull();
        expect(currentMplusScore([{ season: 'x' }])).toBeNull();
    });
});

describe('profileToFields', () => {
    it('maps a full profile onto candidate fields', () => {
        expect(profileToFields(profile())).toEqual({
            playerClass: 'shaman',
            role:        'dps',
            spec:        'Elemental',
            ilvl:        627.4,
            mplusScore:  3102.1,
            mythicKills: 6,
            mythicTotal: 8,
            mythicRaid:  'the-venomous-abyss',
        });
    });

    it('normalises the two irregular class names', () => {
        expect(profileToFields(profile({ class: 'Death Knight' })).playerClass).toBe('deathknight');
        expect(profileToFields(profile({ class: 'Demon Hunter' })).playerClass).toBe('demon_hunter');
    });

    it('prefers the class-derived role over the active spec for a DPS-only class', () => {
        // A mage logged out in no meaningful spec is still a DPS; the class
        // settles it without trusting a snapshot of what they last played.
        const fields = profileToFields(profile({ class: 'Mage', active_spec_role: 'HEALING' }));
        expect(fields.role).toBe('dps');
    });

    it('reads healer and tank roles for classes the class cannot settle', () => {
        expect(profileToFields(profile({ class: 'Priest', active_spec_role: 'HEALING' })).role).toBe('healer');
        expect(profileToFields(profile({ class: 'Warrior', active_spec_role: 'TANK' })).role).toBe('tank');
    });

    it('rejects an error response rather than reading fields off it', () => {
        expect(profileToFields({ statusCode: 400, error: 'Bad Request' })).toBeNull();
        expect(profileToFields(null)).toBeNull();
    });

    it('leaves an absent stat null instead of zero', () => {
        const fields = profileToFields(profile({
            gear: undefined, mythic_plus_scores_by_season: undefined, raid_progression: undefined,
        }));
        expect(fields).toMatchObject({ ilvl: null, mplusScore: null, mythicKills: null });
    });
});

describe('applyEnrichment', () => {
    it('fills the gaps a WoWProgress row leaves', () => {
        const merged = applyEnrichment(candidate({ ilvl: 620 }), profileToFields(profile()));
        expect(merged).toMatchObject({
            playerClass: 'shaman', role: 'dps', mplusScore: 3102.1, mythicKills: 6,
        });
    });

    it('takes the higher of the two readings for every numeric stat', () => {
        // Same reasoning as the cross-source merge: each number is a snapshot
        // from a different moment and none of them go down.
        const merged = applyEnrichment(
            candidate({ ilvl: 640, mythicKills: 8, mplusScore: 3500 }),
            { playerClass: 'shaman', role: 'dps', ilvl: 627.4, mplusScore: 3102.1, mythicKills: 6, mythicTotal: 8 },
        );
        expect(merged).toMatchObject({ ilvl: 640, mythicKills: 8, mplusScore: 3500 });
    });

    it('never overwrites a role the listing stated', () => {
        // The site saw the recruit's own advert; Raider.IO saw whichever spec
        // they last logged out in.
        const merged = applyEnrichment(
            candidate({ role: 'healer', playerClass: 'shaman', origins: { role: 'wowprogress', playerClass: 'wowprogress' } }),
            { playerClass: 'shaman', role: 'dps', ilvl: null, mplusScore: null, mythicKills: null },
        );
        expect(merged.role).toBe('healer');
        expect(merged.origins.role).toBe('wowprogress');
    });

    it('re-runs the class inference once the class is known', () => {
        const merged = applyEnrichment(
            candidate(),
            { playerClass: 'mage', role: null, ilvl: null, mplusScore: null, mythicKills: null },
        );
        expect(merged.role).toBe('dps');
    });

    it('returns the candidate untouched when the lookup came back with nothing', () => {
        const original = candidate();
        expect(applyEnrichment(original, null)).toBe(original);
    });

    it('marks a role it supplied itself, so scoring can distrust it', () => {
        // Raider.IO reports whichever spec the character last logged out in. Good
        // enough to print; not good enough to pick the metric a parse is fetched
        // with, or a raider sitting in their off-spec is queried on the wrong one,
        // comes back empty and is hidden as having no logs.
        const merged = applyEnrichment(
            candidate({ playerClass: 'priest' }),
            { playerClass: 'priest', role: 'healer', ilvl: null, mplusScore: null, mythicKills: null },
        );
        expect(merged.role).toBe('healer');
        expect(merged.origins.role).toBe(ENRICH_ORIGIN);
    });

    it('does not mark a role the class settled, which cannot be wrong', () => {
        const merged = applyEnrichment(
            candidate({ playerClass: 'mage', origins: { role: null, playerClass: 'wowprogress' } }),
            { playerClass: 'mage', role: 'dps', ilvl: null, mplusScore: null, mythicKills: null },
        );
        expect(merged.role).toBe('dps');
        expect(merged.origins.role).toBe('wowprogress');
    });
});

describe('fetchProfileFields', () => {
    const ok = body => async () => ({ ok: true, json: async () => body });

    it('returns parsed fields on a successful lookup', async () => {
        const fields = await fetchProfileFields(candidate(), { fetchImpl: ok(profile()) });
        expect(fields).toMatchObject({ mplusScore: 3102.1, mythicKills: 6 });
    });

    it('returns null for a character Raider.IO has never seen', async () => {
        // The normal case for a fresh alt — additive enrichment, so it is not an
        // error and must not surface as one.
        const fields = await fetchProfileFields(candidate(), {
            fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ statusCode: 400 }) }),
        });
        expect(fields).toBeNull();
    });

    it('swallows a network failure rather than throwing into the harvest', async () => {
        const fields = await fetchProfileFields(candidate(), {
            fetchImpl: async () => { throw new Error('offline'); },
        });
        expect(fields).toBeNull();
    });
});


describe('applyEnrichment boss totals', () => {
    const base = () => ({
        key: 'k', name: 'Thrall', realm: 'tarren-mill', region: 'eu',
        role: null, playerClass: null, ilvl: null, mplusScore: null,
        mythicKills: null, mythicTotal: null, sources: ['guildsofwow'],
        origins: { role: null, playerClass: null }, links: {}, wcl: null,
    });

    it('fills the tier boss count so a kill total can be shown as a fraction', () => {
        const merged = applyEnrichment(base(), profileToFields(profile()));
        expect(merged.mythicKills).toBe(6);
        expect(merged.mythicTotal).toBe(8);
    });

    it('does not take the maximum of two boss counts', () => {
        // The denominator is a property of the raid, identical for everyone —
        // taking a max across sources would be meaningless, and could invent a
        // fraction larger than the raid.
        const merged = applyEnrichment({ ...base(), mythicKills: 3, mythicTotal: 8 },
                                       { mythicKills: 2, mythicTotal: 9 });
        expect(merged.mythicTotal).toBe(8);
        expect(merged.mythicKills).toBe(3);
    });
});
