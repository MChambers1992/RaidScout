// tests/scout-core.test.js
// Unit tests for the Scout aggregator's pure logic. Unlike common.test.js these
// import the real module directly — scout-core.js is an ES module with no
// browser globals, so there is nothing to re-declare.

import { describe, it, expect } from 'vitest';
import {
    slugRealm, makeCandidateKey, normalizeCandidate, mergeCandidate, mergeCandidates,
    passesWowProgressFilters, sortCandidates, matchesQuery, profileLinks,
    toCsv, toWhisperList, runWithConcurrency, hasNoLogs, isScored, classLabel,
    matchesFilters, normalizeFilters, activeFilterCount, hasActiveFilters, DEFAULT_FILTERS,
    normalizeClassKey, roleFromClass, classIconUrl, DPS_ONLY_CLASSES,
    describeScoreError, summarizeScoreErrors, SOURCE_IDS, RETIRED_SOURCE_IDS, SOURCE_META,
    formatMythicProgress,
} from '../src/scout/scout-core.js';

const raw = (over = {}) => ({
    name: 'Thrall', realm: 'Tarren Mill', region: 'eu',
    role: 'dps', playerClass: 'shaman', ilvl: 620, ...over,
});

describe('slugRealm', () => {
    it('collapses the three realm spellings the sites use', () => {
        expect(slugRealm('Tarren Mill')).toBe('tarren-mill');
        expect(slugRealm('tarren-mill')).toBe('tarren-mill');
        expect(slugRealm('Tarren-Mill')).toBe('tarren-mill');
    });

    it('strips apostrophes so Kil\'jaeden matches kiljaeden', () => {
        expect(slugRealm("Kil'jaeden")).toBe('kiljaeden');
        expect(slugRealm('Kil’jaeden')).toBe('kiljaeden');
    });

    it('handles empty input', () => {
        expect(slugRealm(null)).toBe('');
        expect(slugRealm(undefined)).toBe('');
    });
});

describe('makeCandidateKey', () => {
    it('is identical across sites that spell the realm differently', () => {
        const a = makeCandidateKey({ region: 'EU', realm: 'Tarren Mill', name: 'Thrall' });
        const b = makeCandidateKey({ region: 'eu', realm: 'tarren-mill', name: 'thrall' });
        expect(a).toBe(b);
    });

    it('keeps different realms apart', () => {
        expect(makeCandidateKey({ region: 'eu', realm: 'draenor', name: 'Thrall' }))
            .not.toBe(makeCandidateKey({ region: 'eu', realm: 'ravencrest', name: 'Thrall' }));
    });

    it('keeps the same name in different regions apart', () => {
        expect(makeCandidateKey({ region: 'eu', realm: 'draenor', name: 'Thrall' }))
            .not.toBe(makeCandidateKey({ region: 'us', realm: 'draenor', name: 'Thrall' }));
    });
});

describe('normalizeCandidate', () => {
    it('records the originating source', () => {
        expect(normalizeCandidate(raw(), 'wowprogress').sources).toEqual(['wowprogress']);
    });

    it('rejects rows with no usable identity', () => {
        expect(normalizeCandidate(raw({ name: '' }), 'raiderio')).toBeNull();
        expect(normalizeCandidate(raw({ realm: '' }), 'raiderio')).toBeNull();
        expect(normalizeCandidate(raw({ region: '' }), 'raiderio')).toBeNull();
        expect(normalizeCandidate(null, 'raiderio')).toBeNull();
    });

    it('keeps an unknown role null instead of defaulting it to dps', () => {
        // A fake 'dps' here would beat a real 'healer' from another source and
        // score the healer against a DPS threshold they can never meet.
        expect(normalizeCandidate(raw({ role: null }), 'wowprogress').role).toBeNull();
    });

    it('coerces unparseable numbers to null rather than NaN', () => {
        const c = normalizeCandidate(raw({ ilvl: 'n/a', mplusScore: '' }), 'guildsofwow');
        expect(c.ilvl).toBeNull();
        expect(c.mplusScore).toBeNull();
    });

    it('records a per-source profile link', () => {
        const c = normalizeCandidate(raw({ link: 'https://example.test/x' }), 'wowprogress');
        expect(c.links).toEqual({ wowprogress: 'https://example.test/x' });
    });
});

describe('mergeCandidate', () => {
    it('takes the higher value for stats that only go up', () => {
        const older = normalizeCandidate(raw({ ilvl: 615, mplusScore: 2400, mythicKills: 3 }), 'wowprogress');
        const newer = normalizeCandidate(raw({ ilvl: 623, mplusScore: 2600, mythicKills: 5 }), 'raiderio');
        const merged = mergeCandidate(older, newer);
        expect(merged.ilvl).toBe(623);
        expect(merged.mplusScore).toBe(2600);
        expect(merged.mythicKills).toBe(5);
    });

    it('fills a null stat from the other source', () => {
        const a = normalizeCandidate(raw({ mplusScore: null }), 'wowprogress');
        const b = normalizeCandidate(raw({ mplusScore: 2900 }), 'guildsofwow');
        expect(mergeCandidate(a, b).mplusScore).toBe(2900);
    });

    it('prefers the more authoritative source for role conflicts', () => {
        const wp  = normalizeCandidate(raw({ role: 'healer' }), 'wowprogress');   // priority 1
        const gow = normalizeCandidate(raw({ role: 'dps' }),    'guildsofwow');   // priority 4
        expect(mergeCandidate(wp, gow).role).toBe('healer');
        expect(mergeCandidate(gow, wp).role).toBe('healer');
    });

    it('takes a real role over a null one regardless of priority', () => {
        const wpNull = normalizeCandidate(raw({ role: null }), 'wowprogress');
        const gowDps = normalizeCandidate(raw({ role: 'tank' }), 'guildsofwow');
        expect(mergeCandidate(wpNull, gowDps).role).toBe('tank');
    });

    // Regression: the priority comparison used to read existing.sources[0],
    // which stops identifying the surviving value the moment a candidate has
    // been merged once. Here WoWProgress contributes no role, so after the
    // first merge the role is GoW's — but the candidate still lists
    // wowprogress first, and comparing on that weighed a GoW role with
    // WoWProgress's authority and kept it over Raider.IO's.
    it('weighs a merged role by the source it came from, not the first source', () => {
        const wpNull  = normalizeCandidate(raw({ role: null }),     'wowprogress'); // priority 1
        const gowTank = normalizeCandidate(raw({ role: 'tank' }),   'guildsofwow'); // priority 4
        const rioHeal = normalizeCandidate(raw({ role: 'healer' }), 'raiderio');    // priority 2

        const merged = mergeCandidate(mergeCandidate(wpNull, gowTank), rioHeal);
        expect(merged.role).toBe('healer');
    });

    it('records which source supplied the surviving role and class', () => {
        const wpNull = normalizeCandidate(raw({ role: null, playerClass: null }), 'wowprogress');
        const gow    = normalizeCandidate(raw({ role: 'tank', playerClass: 'warrior' }), 'guildsofwow');
        const merged = mergeCandidate(wpNull, gow);
        expect(merged.origins).toEqual({ role: 'guildsofwow', playerClass: 'guildsofwow' });
    });

    it('keeps the more authoritative class across three sources', () => {
        const wpNull = normalizeCandidate(raw({ playerClass: null }),     'wowprogress');
        const gow    = normalizeCandidate(raw({ playerClass: 'warrior' }), 'guildsofwow');
        const rio    = normalizeCandidate(raw({ playerClass: 'priest' }),  'raiderio');
        expect(mergeCandidate(mergeCandidate(wpNull, gow), rio).playerClass).toBe('priest');
    });

    it('unions sources without duplicating', () => {
        const a = normalizeCandidate(raw(), 'wowprogress');
        const b = normalizeCandidate(raw(), 'wowprogress');
        expect(mergeCandidate(a, b).sources).toEqual(['wowprogress']);
    });

    it('keeps links from both sources', () => {
        const a = normalizeCandidate(raw({ link: 'https://wp.test/a' }), 'wowprogress');
        const b = normalizeCandidate(raw({ link: 'https://rio.test/b' }), 'raiderio');
        expect(mergeCandidate(a, b).links).toEqual({
            wowprogress: 'https://wp.test/a',
            raiderio:    'https://rio.test/b',
        });
    });
});

describe('mergeCandidates', () => {
    it('collapses one player posted on three sites into a single row', () => {
        const merged = mergeCandidates([
            normalizeCandidate(raw({ realm: 'Tarren Mill' }), 'wowprogress'),
            normalizeCandidate(raw({ realm: 'tarren-mill' }), 'raiderio'),
            normalizeCandidate(raw({ realm: 'Tarren-Mill' }), 'guildsofwow'),
        ]);
        expect(merged).toHaveLength(1);
        expect(merged[0].sources).toEqual(['wowprogress', 'raiderio', 'guildsofwow']);
    });

    it('keeps distinct players separate', () => {
        expect(mergeCandidates([
            normalizeCandidate(raw({ name: 'Thrall' }), 'wowprogress'),
            normalizeCandidate(raw({ name: 'Jaina' }),  'wowprogress'),
        ])).toHaveLength(2);
    });

    it('ignores nulls from rejected rows', () => {
        expect(mergeCandidates([normalizeCandidate(raw(), 'wowprogress'), null])).toHaveLength(1);
    });

    it('returns an empty list for no input', () => {
        expect(mergeCandidates([])).toEqual([]);
    });
});

describe('passesWowProgressFilters', () => {
    const base = normalizeCandidate(raw(), 'wowprogress');

    it('passes everything with no filters set', () => {
        expect(passesWowProgressFilters(base, {})).toBe(true);
    });

    it('filters by region case-insensitively', () => {
        expect(passesWowProgressFilters(base, { selectedRegions: ['eu'] })).toBe(true);
        expect(passesWowProgressFilters(base, { selectedRegions: ['us'] })).toBe(false);
    });

    it('applies min and max item level', () => {
        expect(passesWowProgressFilters(base, { minIlvl: 630 })).toBe(false);
        expect(passesWowProgressFilters(base, { minIlvl: 610 })).toBe(true);
        expect(passesWowProgressFilters(base, { maxIlvl: 615 })).toBe(false);
        expect(passesWowProgressFilters(base, { maxIlvl: 0 })).toBe(true);
    });

    it('never rejects on a missing field', () => {
        const noIlvl = normalizeCandidate(raw({ ilvl: null, playerClass: null }), 'wowprogress');
        expect(passesWowProgressFilters(noIlvl, { minIlvl: 630, selectedClasses: ['mage'] })).toBe(true);
    });

    it('applies the guild filter', () => {
        expect(passesWowProgressFilters({ ...base, inGuild: true },  { guildFilter: 'out' })).toBe(false);
        expect(passesWowProgressFilters({ ...base, inGuild: false }, { guildFilter: 'out' })).toBe(true);
        expect(passesWowProgressFilters({ ...base, inGuild: false }, { guildFilter: 'in' })).toBe(false);
        expect(passesWowProgressFilters({ ...base, inGuild: true },  { guildFilter: 'any' })).toBe(true);
    });
});

describe('sortCandidates', () => {
    const list = [
        { ...normalizeCandidate(raw({ name: 'A', ilvl: 610 }), 'wowprogress'), wcl: { best: 90, median: 70 } },
        { ...normalizeCandidate(raw({ name: 'B', ilvl: 630 }), 'wowprogress'), wcl: { best: 50, median: 40 } },
        { ...normalizeCandidate(raw({ name: 'C', ilvl: null }), 'wowprogress'), wcl: null },
    ];

    it('sorts numerically descending by default', () => {
        expect(sortCandidates(list, 'ilvl', 'desc').map(c => c.name)).toEqual(['B', 'A', 'C']);
    });

    it('sorts ascending on request', () => {
        expect(sortCandidates(list, 'ilvl', 'asc').map(c => c.name)).toEqual(['A', 'B', 'C']);
    });

    it('sinks missing values to the bottom in BOTH directions', () => {
        expect(sortCandidates(list, 'ilvl', 'asc').at(-1).name).toBe('C');
        expect(sortCandidates(list, 'ilvl', 'desc').at(-1).name).toBe('C');
    });

    it('reads nested WCL scores', () => {
        expect(sortCandidates(list, 'wclMedian', 'desc').map(c => c.name)).toEqual(['A', 'B', 'C']);
    });

    it('does not mutate the input', () => {
        const before = list.map(c => c.name);
        sortCandidates(list, 'ilvl', 'desc');
        expect(list.map(c => c.name)).toEqual(before);
    });

    it('returns a copy unchanged for an unknown sort key', () => {
        expect(sortCandidates(list, 'nope').map(c => c.name)).toEqual(['A', 'B', 'C']);
    });
});

describe('matchesQuery', () => {
    const c = normalizeCandidate(raw(), 'wowprogress');

    it('matches everything on an empty query', () => {
        expect(matchesQuery(c, '')).toBe(true);
        expect(matchesQuery(c, '   ')).toBe(true);
    });

    it('matches name, realm and class case-insensitively', () => {
        expect(matchesQuery(c, 'THRA')).toBe(true);
        expect(matchesQuery(c, 'tarren')).toBe(true);
        expect(matchesQuery(c, 'shaman')).toBe(true);
    });

    it('rejects a non-match', () => {
        expect(matchesQuery(c, 'mage')).toBe(false);
    });
});

describe('profileLinks', () => {
    it('always produces a WarcraftLogs URL even when no site linked one', () => {
        expect(profileLinks(normalizeCandidate(raw(), 'guildsofwow')).warcraftlogs)
            .toBe('https://www.warcraftlogs.com/character/eu/tarren-mill/Thrall');
    });

    it('prefers a real harvested link over a synthesised one', () => {
        const c = normalizeCandidate(raw({ link: 'https://raider.io/characters/eu/tarren-mill/Thrall?x=1' }), 'raiderio');
        expect(profileLinks(c).raiderio).toBe('https://raider.io/characters/eu/tarren-mill/Thrall?x=1');
    });
});

describe('toCsv', () => {
    it('emits a header plus one row per candidate', () => {
        const csv = toCsv([normalizeCandidate(raw(), 'wowprogress')]);
        const lines = csv.split('\n');
        expect(lines[0].startsWith('name,realm,region')).toBe(true);
        expect(lines).toHaveLength(2);
        expect(lines[1]).toContain('Thrall');
    });

    it('quotes and escapes values containing commas or quotes', () => {
        const c = normalizeCandidate(raw({ name: 'Bob' }), 'wowprogress');
        c.note = 'raids Tue, Wed and says "hi"';
        expect(toCsv([c])).toContain('"raids Tue, Wed and says ""hi"""');
    });

    it('renders missing scores as empty cells, not undefined', () => {
        expect(toCsv([normalizeCandidate(raw(), 'wowprogress')])).not.toContain('undefined');
    });
});

describe('toWhisperList', () => {
    it('formats Name-Realm the way the WoW client accepts', () => {
        expect(toWhisperList([normalizeCandidate(raw(), 'wowprogress')])).toBe('Thrall-TarrenMill');
    });

    it('puts one candidate per line', () => {
        expect(toWhisperList([
            normalizeCandidate(raw({ name: 'A' }), 'wowprogress'),
            normalizeCandidate(raw({ name: 'B' }), 'wowprogress'),
        ]).split('\n')).toHaveLength(2);
    });
});

describe('runWithConcurrency', () => {
    it('processes every item', async () => {
        const seen = [];
        await runWithConcurrency([1, 2, 3, 4, 5], async n => { seen.push(n); }, 2);
        expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
    });

    it('never exceeds the limit', async () => {
        let active = 0;
        let peak = 0;
        await runWithConcurrency([1, 2, 3, 4, 5, 6], async () => {
            active++;
            peak = Math.max(peak, active);
            await new Promise(r => setTimeout(r, 5));
            active--;
        }, 2);
        expect(peak).toBeLessThanOrEqual(2);
    });

    it('handles an empty list', async () => {
        await expect(runWithConcurrency([], async () => {}, 4)).resolves.toBeUndefined();
    });
});

describe('slugRealm percent-encoding (regression)', () => {
    it('decodes WoWProgress-style encoded realms so they match other sites', () => {
        // Regression: WoWProgress hrefs carry "/character/eu/Tarren%20Mill/…".
        // Without decoding, this slugged to "tarren%20mill", which matched
        // neither Raider.IO's "tarren-mill" nor the WarcraftLogs API.
        expect(slugRealm('Tarren%20Mill')).toBe('tarren-mill');
        expect(makeCandidateKey({ region: 'eu', realm: 'Tarren%20Mill', name: 'Thrall' }))
            .toBe(makeCandidateKey({ region: 'eu', realm: 'tarren-mill', name: 'Thrall' }));
    });

    it('survives a malformed percent sequence instead of throwing', () => {
        expect(() => slugRealm('100%-realm')).not.toThrow();
        expect(slugRealm('100%-realm')).toBe('100%-realm');
    });

    it('collapses underscores too', () => {
        expect(slugRealm('Tarren_Mill')).toBe('tarren-mill');
    });
});

describe('hasNoLogs', () => {
    it('is true when WarcraftLogs explicitly reports no logs', () => {
        expect(hasNoLogs({ best: null, median: null, notFound: true })).toBe(true);
    });

    it('is true when the lookup succeeded but both metrics are null', () => {
        expect(hasNoLogs({ best: null, median: null })).toBe(true);
    });

    it('is false for a real score, including a zero parse', () => {
        expect(hasNoLogs({ best: 40, median: 12 })).toBe(false);
        expect(hasNoLogs({ best: 0, median: 0 })).toBe(false);
    });

    it('is false when only one metric came back', () => {
        expect(hasNoLogs({ best: 55, median: null })).toBe(false);
        expect(hasNoLogs({ best: null, median: 55 })).toBe(false);
    });

    it('is false for any errored lookup, however it failed', () => {
        // An error describes the request, not the player — treating it as "no
        // logs" would empty the list on a missing key or a rate limit.
        for (const error of ['NO_CREDENTIALS', 'FETCH_TIMEOUT', 'RATE_LIMITED:60', 'NO_RESPONSE']) {
            expect(hasNoLogs({ best: null, median: null, error })).toBe(false);
        }
    });

    it('is false for a candidate that was never scored', () => {
        expect(hasNoLogs(null)).toBe(false);
        expect(hasNoLogs(undefined)).toBe(false);
    });
});

describe('isScored', () => {
    it('separates a real answer from a failed or absent one', () => {
        expect(isScored({ best: 70, median: 60 })).toBe(true);
        expect(isScored({ best: null, median: null, notFound: true })).toBe(true);
        expect(isScored({ error: 'FETCH_TIMEOUT' })).toBe(false);
        expect(isScored(null)).toBe(false);
    });
});

// Mirrors isBelowThreshold() in scout/scout.js, which delegates to common.js's
// failsWclThresholds and adds only the not-scored-yet guard. Re-declared here
// because common.js is a classic content script with no export surface — keep
// this copy in sync with the original when you touch it.
describe('Scout hide rule (no logs counts as below threshold)', () => {
    function hasNoWclLogs(score) {
        if (!score || score.error) return false;
        return !!score.notFound || (score.best === null && score.median === null);
    }

    function failsWclThresholds(score, { minBest = 0, minMedian = 0 }) {
        if (!score) return false;
        if (score.error) return false;
        if (hasNoWclLogs(score)) return true;
        if (minBest   > 0 && score.best   !== null && score.best   < minBest)   return true;
        if (minMedian > 0 && score.median !== null && score.median < minMedian) return true;
        return false;
    }

    const isBelowThreshold = (wcl, settings = { minBest: 60, minMedian: 50 }) => {
        if (!wcl) return false;
        return failsWclThresholds(wcl, settings);
    };

    it('hides a no-logs candidate, with no setting to opt out of it', () => {
        // The reported bug: these were showing up alongside qualified raiders.
        expect(isBelowThreshold({ best: null, median: null, notFound: true })).toBe(true);
        expect(isBelowThreshold({ best: null, median: null })).toBe(true);
    });

    it('still hides a genuinely low parse', () => {
        expect(isBelowThreshold({ best: 30, median: 20 })).toBe(true);
    });

    it('keeps a candidate above the thresholds', () => {
        expect(isBelowThreshold({ best: 90, median: 75 })).toBe(false);
    });

    it('keeps candidates that could not be scored', () => {
        expect(isBelowThreshold(null)).toBe(false);                                  // never scored
        expect(isBelowThreshold({ error: 'NO_CREDENTIALS' })).toBe(false);           // no API key
        expect(isBelowThreshold({ error: 'RATE_LIMITED:60', rateLimitMs: 60000 })).toBe(false);
        expect(isBelowThreshold({ error: 'FETCH_TIMEOUT' })).toBe(false);
    });

    it('hides no-logs candidates even with no thresholds set', () => {
        expect(isBelowThreshold({ best: null, median: null, notFound: true },
            { minBest: 0, minMedian: 0 })).toBe(true);
    });
});

describe('classLabel', () => {
    it('spells out the two irregular class names', () => {
        // A naive underscore replace leaves "deathknight" as one word.
        expect(classLabel('deathknight')).toBe('Death Knight');
        expect(classLabel('demon_hunter')).toBe('Demon Hunter');
    });

    it('capitalises the regular ones', () => {
        expect(classLabel('warrior')).toBe('Warrior');
        expect(classLabel('evoker')).toBe('Evoker');
    });

    it('returns null for an unknown class', () => {
        expect(classLabel(null)).toBeNull();
        expect(classLabel('')).toBeNull();
    });
});

// ─── Structured filters ────────────────────────────────────────────────────────
// These persist between runs, so the failure that matters is a filter that
// quietly excludes everyone — an officer would read a short list as a bad
// harvest rather than as their own setting from a fortnight ago.

describe('matchesFilters', () => {
    const candidate = (over = {}) => normalizeCandidate(raw({
        role: 'healer', playerClass: 'priest', ilvl: 635, mplusScore: 2800, mythicKills: 6, ...over,
    }), over.source || 'wowprogress');

    it('keeps everyone when nothing is set', () => {
        expect(matchesFilters(candidate(), DEFAULT_FILTERS)).toBe(true);
        expect(matchesFilters(candidate(), {})).toBe(true);
        expect(matchesFilters(candidate(), undefined)).toBe(true);
    });

    it('filters by role, class and region', () => {
        expect(matchesFilters(candidate(), { roles: ['healer'] })).toBe(true);
        expect(matchesFilters(candidate(), { roles: ['tank'] })).toBe(false);
        expect(matchesFilters(candidate(), { roles: ['tank', 'healer'] })).toBe(true);

        expect(matchesFilters(candidate(), { classes: ['priest'] })).toBe(true);
        expect(matchesFilters(candidate(), { classes: ['mage'] })).toBe(false);

        expect(matchesFilters(candidate(), { regions: ['eu'] })).toBe(true);
        expect(matchesFilters(candidate(), { regions: ['us'] })).toBe(false);
        expect(matchesFilters(candidate(), { regions: ['EU'] })).toBe(true);   // case-insensitive
    });

    it('excludes a candidate whose role or class was never resolved', () => {
        // Asking for healers and being shown someone whose role is unknown
        // would waste the officer's time; the honest answer is to leave them
        // out of a role-filtered list.
        expect(matchesFilters(candidate({ role: null }), { roles: ['healer'] })).toBe(false);
        expect(matchesFilters(candidate({ playerClass: null }), { classes: ['priest'] })).toBe(false);
    });

    it('applies numeric minimums', () => {
        expect(matchesFilters(candidate(), { minIlvl: 630 })).toBe(true);
        expect(matchesFilters(candidate(), { minIlvl: 640 })).toBe(false);
        expect(matchesFilters(candidate(), { minMplus: 3000 })).toBe(false);
        expect(matchesFilters(candidate(), { minMythic: 6 })).toBe(true);
    });

    it('never fails a minimum on a stat the site did not report', () => {
        // WoWProgress rows carry no M+ score at all. Treating absent as zero
        // would silently drop every candidate from the sites that omit a stat.
        const noStats = candidate({ mplusScore: null, mythicKills: null, ilvl: null });
        expect(matchesFilters(noStats, { minMplus: 3000, minMythic: 9, minIlvl: 700 })).toBe(true);
    });

    it('filters by the sources a candidate was seen on', () => {
        expect(matchesFilters(candidate({ source: 'raiderio' }), { sources: ['raiderio'] })).toBe(true);
        expect(matchesFilters(candidate({ source: 'raiderio' }), { sources: ['guildsofwow'] })).toBe(false);
    });

    it('can require a candidate to have been seen on more than one site', () => {
        const single = candidate();
        const merged = mergeCandidate(candidate(), normalizeCandidate(raw(), 'raiderio'));
        expect(matchesFilters(single, { multiSource: true })).toBe(false);
        expect(matchesFilters(merged, { multiSource: true })).toBe(true);
    });

    it('combines every clause as AND', () => {
        const filters = { roles: ['healer'], regions: ['eu'], minIlvl: 630 };
        expect(matchesFilters(candidate(), filters)).toBe(true);
        expect(matchesFilters(candidate({ ilvl: 620 }), filters)).toBe(false);
    });
});

describe('normalizeFilters', () => {
    it('returns the do-nothing shape for junk', () => {
        for (const junk of [null, undefined, 'nonsense', 42, []]) {
            expect(normalizeFilters(junk)).toEqual(DEFAULT_FILTERS);
        }
    });

    it('survives stored settings whose types have since changed', () => {
        // Storage outlives the code that wrote it; a render must not throw
        // because an old install saved a string where a list now lives.
        const out = normalizeFilters({ roles: 'healer', classes: [1, 'priest', null], minIlvl: 'abc', multiSource: 'yes' });
        expect(out.roles).toEqual([]);
        expect(out.classes).toEqual(['priest']);
        expect(out.minIlvl).toBe(0);
        expect(out.multiSource).toBe(false);
    });

    it('discards negative and zero minimums as "no opinion"', () => {
        expect(normalizeFilters({ minIlvl: -5 }).minIlvl).toBe(0);
        expect(normalizeFilters({ minIlvl: 0 }).minIlvl).toBe(0);
    });
});

describe('activeFilterCount', () => {
    it('counts nothing for the default shape', () => {
        expect(activeFilterCount(DEFAULT_FILTERS)).toBe(0);
        expect(hasActiveFilters(DEFAULT_FILTERS)).toBe(false);
    });

    it('counts each selected value and each minimum in use', () => {
        expect(activeFilterCount({ roles: ['tank', 'healer'], minIlvl: 630, multiSource: true })).toBe(4);
        expect(hasActiveFilters({ minMythic: 1 })).toBe(true);
    });
});


describe('normalizeClassKey', () => {
    it('maps the display names the sites and APIs use back to storage keys', () => {
        expect(normalizeClassKey('Death Knight')).toBe('deathknight');
        expect(normalizeClassKey('Demon Hunter')).toBe('demon_hunter');
        expect(normalizeClassKey('Shaman')).toBe('shaman');
        expect(normalizeClassKey('demon_hunter')).toBe('demon_hunter');
    });

    it('rejects anything that is not a class rather than inventing a key', () => {
        expect(normalizeClassKey('Tinker')).toBeNull();
        expect(normalizeClassKey('')).toBeNull();
        expect(normalizeClassKey(null)).toBeNull();
    });
});

describe('roleFromClass', () => {
    it('settles the role for the four classes with no tank or healer spec', () => {
        for (const cls of DPS_ONLY_CLASSES) expect(roleFromClass(cls)).toBe('dps');
        expect(DPS_ONLY_CLASSES.sort()).toEqual(['hunter', 'mage', 'rogue', 'warlock']);
    });

    it('stays unknown for every class that has a non-DPS spec', () => {
        // Guessing 'dps' here would score a healer against a DPS threshold they
        // can never meet, which is the trap the whole role pipeline avoids.
        for (const cls of ['warrior', 'paladin', 'priest', 'shaman', 'monk',
                           'druid', 'deathknight', 'demon_hunter', 'evoker']) {
            expect(roleFromClass(cls)).toBeNull();
        }
        expect(roleFromClass(null)).toBeNull();
    });
});

describe('normalizeCandidate role inference', () => {
    it('assigns dps to a listing that gave a DPS-only class but no role', () => {
        const c = normalizeCandidate(raw({ role: null, playerClass: 'warlock' }), 'wowprogress');
        expect(c.role).toBe('dps');
        expect(c.origins.role).toBe('wowprogress');
    });

    it('leaves the role unknown when the class could be anything', () => {
        expect(normalizeCandidate(raw({ role: null, playerClass: 'druid' }), 'wowprogress').role).toBeNull();
    });

    it('does not override a role the listing actually stated', () => {
        // Only relevant if a site ever mislabels one, but the stated role is the
        // recruit's own advert and the inference agrees with it anyway.
        expect(normalizeCandidate(raw({ role: 'dps', playerClass: 'mage' }), 'raiderio').role).toBe('dps');
    });

    it('lets an inferred role win a merge, because it cannot be wrong', () => {
        const wp  = normalizeCandidate(raw({ role: null, playerClass: 'rogue' }), 'wowprogress');
        const gow = normalizeCandidate(raw({ role: 'tank', playerClass: 'rogue' }), 'guildsofwow');
        expect(mergeCandidate(wp, gow).role).toBe('dps');
    });
});

describe('classIconUrl', () => {
    it('points at the bundled icon named for the storage key', () => {
        expect(classIconUrl('demon_hunter')).toBe('../../img/class/demon_hunter.jpg');
        expect(classIconUrl('deathknight')).toBe('../../img/class/deathknight.jpg');
    });

    it('is null for an unknown class, so no broken image is rendered', () => {
        expect(classIconUrl('tinker')).toBeNull();
        expect(classIconUrl(null)).toBeNull();
    });
});


describe('describeScoreError', () => {
    it('names the fix for each failure an officer can actually act on', () => {
        expect(describeScoreError('NO_CREDENTIALS').hint).toMatch(/Client ID and Secret/);
        expect(describeScoreError('CLOUDFLARE_BLOCKED:300').hint).toMatch(/warcraftlogs\.com in a normal tab/);
        expect(describeScoreError('RATE_LIMITED:60').headline).toMatch(/rate limit/i);
        expect(describeScoreError('NO_RESPONSE').hint).toMatch(/service-worker console/);
    });

    it('separates bad credentials from a broken token endpoint', () => {
        // Same message prefix, completely different fix — re-entering a Client
        // Secret does nothing about a 500 from the OAuth endpoint.
        expect(describeScoreError('WCL token request failed (401): x').hint).toMatch(/wrong or has been revoked/);
        expect(describeScoreError('WCL token request failed (500): x').hint).toMatch(/OAuth endpoint/);
    });

    it('flags a GraphQL rejection as needing an extension fix, not a setting change', () => {
        const described = describeScoreError('WCL GraphQL error: Cannot query field "zoneRankings"');
        expect(described.hint).toMatch(/API schema changed/);
        // The raw message is kept verbatim: it is the only thing that identifies
        // which part of the query the API stopped accepting.
        expect(described.headline).toContain('Cannot query field "zoneRankings"');
    });

    it('passes an unrecognised message through rather than inventing advice', () => {
        expect(describeScoreError('something new')).toEqual({ headline: 'something new', hint: null });
        expect(describeScoreError(undefined).headline).toBe('UNKNOWN_ERROR');
    });
});

describe('summarizeScoreErrors', () => {
    const scored = wcl => ({ name: 'x', wcl });

    it('collapses identical failures into one entry with a count', () => {
        const summary = summarizeScoreErrors([
            scored({ error: 'NO_CREDENTIALS' }),
            scored({ error: 'NO_CREDENTIALS' }),
            scored({ error: 'FETCH_TIMEOUT' }),
        ]);
        expect(summary.length).toBe(2);
        expect(summary[0]).toMatchObject({ message: 'NO_CREDENTIALS', count: 2 });
        expect(summary[1]).toMatchObject({ message: 'FETCH_TIMEOUT', count: 1 });
    });

    it('ignores candidates that scored fine or were never scored', () => {
        expect(summarizeScoreErrors([
            scored({ best: 90, median: 80 }),
            scored(null),
            { name: 'no wcl key at all' },
        ])).toEqual([]);
    });
});


describe('retired sources', () => {
    it('drops a retired source from a stored filter instead of keeping it', () => {
        // Storage outlives the code that wrote it. A filter naming only
        // WarcraftLogs would otherwise match no candidate at all, and an empty
        // table reads as a harvest that found nobody rather than a stale filter.
        expect(normalizeFilters({ sources: ['warcraftlogs'] }).sources).toEqual([]);
        expect(normalizeFilters({ sources: ['raiderio', 'warcraftlogs'] }).sources).toEqual(['raiderio']);
    });

    it('does not count a retired source towards the active-filter badge', () => {
        expect(activeFilterCount({ ...DEFAULT_FILTERS, sources: ['warcraftlogs'] })).toBe(0);
    });

    it('keeps the three harvestable sources, each with display metadata', () => {
        expect(SOURCE_IDS).toEqual(['wowprogress', 'raiderio', 'guildsofwow']);
        for (const id of SOURCE_IDS) {
            expect(SOURCE_META[id].label).toBeTruthy();
            expect(SOURCE_META[id].colour).toMatch(/^#/);
        }
    });

    it('gives every source a distinct merge priority', () => {
        // preferByPriority breaks class/role ties on these; two sources sharing a
        // rank would make the winner depend on harvest order.
        const priorities = SOURCE_IDS.map(id => SOURCE_META[id].priority);
        expect(new Set(priorities).size).toBe(priorities.length);
    });

    it('lists WarcraftLogs as retired rather than forgetting it', () => {
        expect(RETIRED_SOURCE_IDS).toEqual(['warcraftlogs']);
        expect(SOURCE_IDS).not.toContain('warcraftlogs');
    });
});


describe('formatMythicProgress', () => {
    it('shows the tier denominator, because a bare kill count says nothing', () => {
        // 6/8 is most of a tier; 6/12 is a third of one. The number alone cannot
        // be compared to anything, and the denominator changes every raid.
        expect(formatMythicProgress({ mythicKills: 6, mythicTotal: 8 })).toBe('6/8');
        expect(formatMythicProgress({ mythicKills: 0, mythicTotal: 8 })).toBe('0/8');
    });

    it('falls back to the bare count when only a listing supplied the kills', () => {
        // Guilds of WoW prints a kill count with no boss total, and the Raider.IO
        // cross-reference may not have run or may not know the character.
        expect(formatMythicProgress({ mythicKills: 4, mythicTotal: null })).toBe('4');
        expect(formatMythicProgress({ mythicKills: 4 })).toBe('4');
    });

    it('is null when the kills are unknown, so the cell can show a dash', () => {
        expect(formatMythicProgress({ mythicKills: null, mythicTotal: 8 })).toBeNull();
        expect(formatMythicProgress({})).toBeNull();
        expect(formatMythicProgress(null)).toBeNull();
    });

    it('never renders a fraction over a zero total', () => {
        // A total of 0 is not a denominator anyone can read.
        expect(formatMythicProgress({ mythicKills: 3, mythicTotal: 0 })).toBe('3');
    });
});

describe('mythicTotal through the merge', () => {
    const src = (over, source) => normalizeCandidate(raw(over), source);

    it('fills the boss count from whichever source knew it', () => {
        const merged = mergeCandidate(src({ mythicKills: 3 }, 'wowprogress'),
                                      src({ mythicKills: 5, mythicTotal: 8 }, 'guildsofwow'));
        expect(merged.mythicKills).toBe(5);
        expect(merged.mythicTotal).toBe(8);
    });

    it('does not take the higher of two boss counts', () => {
        // The denominator describes the raid, not the player, so there is no
        // freshest reading to prefer — and a max could invent a fraction larger
        // than the raid itself.
        const merged = mergeCandidate(src({ mythicKills: 3, mythicTotal: 8 }, 'wowprogress'),
                                      src({ mythicKills: 3, mythicTotal: 12 }, 'guildsofwow'));
        expect(merged.mythicTotal).toBe(8);
    });
});
