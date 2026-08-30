// tests/scout-core.test.js
// Unit tests for the Scout aggregator's pure logic. Unlike common.test.js these
// import the real module directly — scout-core.js is an ES module with no
// browser globals, so there is nothing to re-declare.

import { describe, it, expect } from 'vitest';
import {
    slugRealm, makeCandidateKey, normalizeCandidate, mergeCandidate, mergeCandidates,
    passesWowProgressFilters, sortCandidates, matchesQuery, profileLinks,
    toCsv, toWhisperList, runWithConcurrency, hasNoLogs, isScored, classLabel,
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

// Mirrors isBelowThreshold() in scout.js, which delegates to common.js's
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
