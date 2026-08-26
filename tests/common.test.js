/**
 * tests/common.test.js
 *
 * Unit tests for logic extracted from common.js and wcl-api.js. Most of it is
 * pure, but the getRecruitmentRole suite at the end walks a real card element,
 * so the whole file runs under jsdom.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';

// ─── Inline the pure functions under test ────────────────────────────────────
// (No build step — we just re-declare the functions here rather than import
//  browser-globals-dependent files. When a build step is added in future,
//  extract these to a shared utils module and import directly.)

function normalizeClassName(name) {
    if (!name) return null;
    const lower = name.toLowerCase().replace(/ /g, '');
    if (lower === 'deathknight') return 'deathknight';
    if (lower === 'demonhunter') return 'demon_hunter';
    return lower.replace(/ /g, '_');
}

function hasNoWclLogs(score) {
    if (!score || score.error) return false;
    return !!score.notFound || (score.best === null && score.median === null);
}

function failsWclThresholds(score, { minBest, minMedian }) {
    if (!score) return false;
    if (score.error) return false;
    if (hasNoWclLogs(score)) return true;
    if (minBest   > 0 && score.best   !== null && score.best   < minBest)   return true;
    if (minMedian > 0 && score.median !== null && score.median < minMedian) return true;
    return false;
}

function roleToMetric(role) {
    if (role === 'healer') return 'hps';
    return 'dps';
}

function characterKey({ region, realm, name, role }) {
    return `${region}/${realm}/${name}/${role || 'dps'}`.toLowerCase();
}

function normalizeCharacter({ region, realm, name, role }) {
    return {
        region: region.toLowerCase(),
        realm:  realm.replace(/\s/g, '-').toLowerCase(),
        name:   decodeURIComponent(name.split('?')[0]),
        role:   role || 'dps',
    };
}

// ─── normalizeClassName ───────────────────────────────────────────────────────

describe('normalizeClassName', () => {
    it('returns null for null/empty input', () => {
        expect(normalizeClassName(null)).toBe(null);
        expect(normalizeClassName('')).toBe(null);
    });
    it('normalizes "Death Knight" variants', () => {
        expect(normalizeClassName('Death Knight')).toBe('deathknight');
        expect(normalizeClassName('DeathKnight')).toBe('deathknight');
        expect(normalizeClassName('death knight')).toBe('deathknight');
    });
    it('normalizes "Demon Hunter" variants', () => {
        expect(normalizeClassName('Demon Hunter')).toBe('demon_hunter');
        expect(normalizeClassName('demonhunter')).toBe('demon_hunter');
        expect(normalizeClassName('DemonHunter')).toBe('demon_hunter');
    });
    it('lowercases simple class names', () => {
        expect(normalizeClassName('Warrior')).toBe('warrior');
        expect(normalizeClassName('MAGE')).toBe('mage');
        expect(normalizeClassName('Evoker')).toBe('evoker');
    });
});

// ─── failsWclThresholds ───────────────────────────────────────────────────────

describe('failsWclThresholds', () => {
    const cfg = { minBest: 60, minMedian: 50 };

    it('hides when best and median both below threshold', () => {
        expect(failsWclThresholds({ best: 40, median: 30 }, cfg)).toBe(true);
    });
    it('keeps when both above threshold', () => {
        expect(failsWclThresholds({ best: 95, median: 80 }, cfg)).toBe(false);
    });
    it('hides when median is fine but best is below', () => {
        expect(failsWclThresholds({ best: 50, median: 70 }, cfg)).toBe(true);
    });
    it('hides when best is fine but median is below', () => {
        expect(failsWclThresholds({ best: 70, median: 40 }, cfg)).toBe(true);
    });
    it('keeps exactly at threshold (>= not >)', () => {
        expect(failsWclThresholds({ best: 60, median: 50 }, cfg)).toBe(false);
    });
    it('never hides on a transient error (fail-open)', () => {
        expect(failsWclThresholds({ best: null, median: null, error: 'RATE_LIMITED' }, cfg)).toBe(false);
        expect(failsWclThresholds({ best: null, median: null, error: 'FETCH_TIMEOUT' }, cfg)).toBe(false);
        expect(failsWclThresholds({ best: null, median: null, error: 'NO_RESPONSE' }, cfg)).toBe(false);
    });
    it('hides a character WarcraftLogs has no logs for', () => {
        expect(failsWclThresholds({ best: null, median: null, notFound: true }, cfg)).toBe(true);
    });
    it('hides a successful lookup that came back with both metrics null', () => {
        expect(failsWclThresholds({ best: null, median: null }, cfg)).toBe(true);
    });
    it('hides a no-logs character even with no thresholds set', () => {
        expect(failsWclThresholds({ best: null, median: null, notFound: true },
            { minBest: 0, minMedian: 0 })).toBe(true);
    });
    it('keeps a character that was never scored', () => {
        // Distinct from "no logs": nothing was asked, so nothing is known.
        expect(failsWclThresholds(null, cfg)).toBe(false);
    });
    it('keeps a no-data result that carries an error, however it failed', () => {
        // An error describes the request, not the player. Hiding on these would
        // empty a whole page when credentials are missing or a rate limit hits.
        expect(failsWclThresholds({ best: null, median: null, error: 'NO_CREDENTIALS' }, cfg)).toBe(false);
        expect(failsWclThresholds({ best: null, median: null, notFound: true, error: 'FETCH_TIMEOUT' }, cfg)).toBe(false);
    });
    it('handles one metric present: best ok, median null → keep', () => {
        expect(failsWclThresholds({ best: 80, median: null }, cfg)).toBe(false);
    });
    it('handles one metric present: median below, best null → hide', () => {
        expect(failsWclThresholds({ best: null, median: 30 }, cfg)).toBe(true);
    });
    it('disabled thresholds (0) never hide', () => {
        expect(failsWclThresholds({ best: 5, median: 5 }, { minBest: 0, minMedian: 0 })).toBe(false);
    });
    it('healer with hps score is evaluated the same way (metric agnostic)', () => {
        // The threshold function doesn't know about metric; it just compares numbers
        expect(failsWclThresholds({ best: 45, median: 40 }, cfg)).toBe(true);
    });
});

// ─── roleToMetric ─────────────────────────────────────────────────────────────

describe('roleToMetric', () => {
    it('maps healer to hps', () => {
        expect(roleToMetric('healer')).toBe('hps');
    });
    it('maps dps to dps', () => {
        expect(roleToMetric('dps')).toBe('dps');
    });
    it('maps tank to dps', () => {
        expect(roleToMetric('tank')).toBe('dps');
    });
    it('maps null/undefined to dps', () => {
        expect(roleToMetric(null)).toBe('dps');
        expect(roleToMetric(undefined)).toBe('dps');
    });
});

// ─── characterKey ─────────────────────────────────────────────────────────────

describe('characterKey', () => {
    it('produces lowercase slash-separated key', () => {
        expect(characterKey({ region: 'EU', realm: 'kazzak', name: 'Pewpew', role: 'dps' }))
            .toBe('eu/kazzak/pewpew/dps');
    });
    it('DPS and healer produce different cache keys for same character', () => {
        const base = { region: 'eu', realm: 'kazzak', name: 'Altchar' };
        expect(characterKey({ ...base, role: 'dps' })).not.toBe(characterKey({ ...base, role: 'healer' }));
    });
    it('defaults missing role to dps', () => {
        expect(characterKey({ region: 'eu', realm: 'kazzak', name: 'x', role: undefined }))
            .toBe('eu/kazzak/x/dps');
    });
});

// ─── normalizeCharacter (realm slug + name decoding) ─────────────────────────

describe('normalizeCharacter', () => {
    it('lowercases region and realm', () => {
        const c = normalizeCharacter({ region: 'EU', realm: 'Kazzak', name: 'Test', role: 'dps' });
        expect(c.region).toBe('eu');
        expect(c.realm).toBe('kazzak');
    });
    it('converts spaces to hyphens in realm', () => {
        const c = normalizeCharacter({ region: 'eu', realm: 'Twisting Nether', name: 'x', role: 'dps' });
        expect(c.realm).toBe('twisting-nether');
    });
    it('already-hyphenated realm stays intact', () => {
        const c = normalizeCharacter({ region: 'us', realm: 'Area-52', name: 'x', role: 'dps' });
        expect(c.realm).toBe('area-52');
    });
    it('strips query string from name', () => {
        const c = normalizeCharacter({ region: 'eu', realm: 'silvermoon', name: 'Char?spec=1', role: 'dps' });
        expect(c.name).toBe('Char');
    });
    it('decodes percent-encoded characters in name', () => {
        const c = normalizeCharacter({ region: 'eu', realm: 'silvermoon', name: '%C3%89ly', role: 'dps' });
        expect(c.name).toBe('Ély');
    });
    it('defaults null role to dps', () => {
        const c = normalizeCharacter({ region: 'eu', realm: 'k', name: 'x', role: null });
        expect(c.role).toBe('dps');
    });
});

// ─── Edge cases: combined / boundary ─────────────────────────────────────────

describe('edge cases', () => {
    it('failsWclThresholds: score with best=0 is treated as data (not null)', () => {
        // A parse of 0 is real data (someone logged a 0 parse), not "no data"
        const cfg = { minBest: 1, minMedian: 0 };
        expect(failsWclThresholds({ best: 0, median: 50 }, cfg)).toBe(true);
    });
    it('failsWclThresholds: score with best=100 is perfect and kept', () => {
        const cfg = { minBest: 99, minMedian: 99 };
        expect(failsWclThresholds({ best: 100, median: 100 }, cfg)).toBe(false);
    });
    it('characterKey is case-insensitive across region/realm/name', () => {
        const a = characterKey({ region: 'EU', realm: 'KAZZAK', name: 'HERO', role: 'dps' });
        const b = characterKey({ region: 'eu', realm: 'kazzak', name: 'hero', role: 'dps' });
        expect(a).toBe(b);
    });
});

// ─── thresholdsForRole ────────────────────────────────────────────────────────

function thresholdsForRole(role, settings) {
    if (role === 'healer') {
        return { minBest: settings.minBestHealer || 0, minMedian: settings.minMedianHealer || 0 };
    }
    if (role === 'tank') {
        return { minBest: settings.minBestTank || settings.minBest || 0, minMedian: settings.minMedianTank || settings.minMedian || 0 };
    }
    return { minBest: settings.minBest || 0, minMedian: settings.minMedian || 0 };
}

function failsWclThresholdsRoleAware(score, settings, role) {
    const { minBest, minMedian } = thresholdsForRole(role || 'dps', settings);
    if (!score) return false;
    if (score.error) return false;
    if (hasNoWclLogs(score)) return true;
    if (minBest   > 0 && score.best   !== null && score.best   < minBest)   return true;
    if (minMedian > 0 && score.median !== null && score.median < minMedian) return true;
    return false;
}

describe('thresholdsForRole', () => {
    const settings = {
        minBest: 60, minMedian: 50,
        minBestHealer: 70, minMedianHealer: 65,
        minBestTank: 40, minMedianTank: 35,
    };

    it('returns DPS thresholds for dps role', () => {
        const t = thresholdsForRole('dps', settings);
        expect(t.minBest).toBe(60);
        expect(t.minMedian).toBe(50);
    });
    it('returns HPS thresholds for healer role', () => {
        const t = thresholdsForRole('healer', settings);
        expect(t.minBest).toBe(70);
        expect(t.minMedian).toBe(65);
    });
    it('returns tank thresholds for tank role', () => {
        const t = thresholdsForRole('tank', settings);
        expect(t.minBest).toBe(40);
        expect(t.minMedian).toBe(35);
    });
    it('tank falls back to DPS thresholds when tank-specific not set', () => {
        const noTank = { ...settings, minBestTank: 0, minMedianTank: 0 };
        const t = thresholdsForRole('tank', noTank);
        expect(t.minBest).toBe(60);
        expect(t.minMedian).toBe(50);
    });
    it('null role defaults to DPS', () => {
        const t = thresholdsForRole(null, settings);
        expect(t.minBest).toBe(60);
    });
});

describe('failsWclThresholds role-aware', () => {
    const settings = {
        minBest: 60, minMedian: 50,
        minBestHealer: 70, minMedianHealer: 65,
        minBestTank: 0, minMedianTank: 0,
    };

    it('healer with 75/70 HPS passes healer thresholds', () => {
        expect(failsWclThresholdsRoleAware({ best: 75, median: 70 }, settings, 'healer')).toBe(false);
    });
    it('healer with 65/60 HPS fails healer thresholds (minBestHealer=70)', () => {
        expect(failsWclThresholdsRoleAware({ best: 65, median: 60 }, settings, 'healer')).toBe(true);
    });
    it('healer with 65/60 HPS would PASS dps thresholds — proving role isolation', () => {
        expect(failsWclThresholdsRoleAware({ best: 65, median: 60 }, settings, 'dps')).toBe(false);
    });
    it('tank with no tank-specific thresholds falls back to DPS thresholds', () => {
        expect(failsWclThresholdsRoleAware({ best: 50, median: 40 }, settings, 'tank')).toBe(true);
    });
    it('dps at exactly DPS thresholds passes', () => {
        expect(failsWclThresholdsRoleAware({ best: 60, median: 50 }, settings, 'dps')).toBe(false);
    });
    it('error is always fail-open regardless of role', () => {
        expect(failsWclThresholdsRoleAware({ best: null, median: null, error: 'TIMEOUT' }, settings, 'healer')).toBe(false);
    });
});

// ─── extractCharacterFromUrl ──────────────────────────────────────────────────

function extractCharacterFromUrl(url) {
    try {
        const parts = new URL(url).pathname.split('/').filter(Boolean);
        const idx = parts.indexOf('character');
        if (idx === -1 || parts.length < idx + 4) return null;
        return {
            region: parts[idx + 1].toLowerCase(),
            realm:  parts[idx + 2].toLowerCase(),
            name:   parts[idx + 3].split('?')[0],
            role:   null,
        };
    } catch { return null; }
}

describe('extractCharacterFromUrl', () => {
    it('parses a standard WCL character URL', () => {
        const c = extractCharacterFromUrl('https://www.warcraftlogs.com/character/eu/kazzak/heroname');
        expect(c).toEqual({ region: 'eu', realm: 'kazzak', name: 'heroname', role: null });
    });
    it('lowercases region and realm', () => {
        const c = extractCharacterFromUrl('https://www.warcraftlogs.com/character/US/Area-52/Hero');
        expect(c.region).toBe('us');
        expect(c.realm).toBe('area-52');
        expect(c.name).toBe('Hero');
    });
    it('strips trailing spec tab from name', () => {
        const c = extractCharacterFromUrl('https://www.warcraftlogs.com/character/eu/kazzak/hero?spec=1');
        expect(c.name).toBe('hero');
    });
    it('returns null for non-character WCL URLs', () => {
        expect(extractCharacterFromUrl('https://www.warcraftlogs.com/guild/eu/kazzak/myguild')).toBeNull();
        expect(extractCharacterFromUrl('https://www.warcraftlogs.com/zone/rankings/38')).toBeNull();
    });
    it('returns null for malformed URLs', () => {
        expect(extractCharacterFromUrl('not a url')).toBeNull();
    });
});

// ─── No-logs rule applied per role ───────────────────────────────────────────
// The rule must not depend on which threshold pair a role resolves to: someone
// with no parses is below every threshold, including a role whose minimums are
// all zero.

describe('no-logs rule is role-independent', () => {
    const settings = {
        minBest: 60, minMedian: 50,
        minBestHealer: 70, minMedianHealer: 65,
        minBestTank: 0, minMedianTank: 0,
    };

    for (const role of ['dps', 'healer', 'tank', null]) {
        it(`hides a no-logs ${role ?? 'unknown-role'} character`, () => {
            expect(failsWclThresholdsRoleAware(
                { best: null, median: null, notFound: true }, settings, role)).toBe(true);
        });

        it(`keeps an errored lookup for a ${role ?? 'unknown-role'} character`, () => {
            expect(failsWclThresholdsRoleAware(
                { best: null, median: null, error: 'RATE_LIMITED:60' }, settings, role)).toBe(false);
        });
    }
});

// ─── Shared sort preference + migration ──────────────────────────────────────
// Mirrors wclSortEnabled() in common.js. Sorting by parse used to be three
// per-site keys; it is now one. Installs that set the old keys must keep the
// behaviour they chose without touching settings again.

function wclSortEnabled(options) {
    if (typeof options.wclSortByParse === 'boolean') return options.wclSortByParse;
    return !!(options.wpWclSort || options.rioWclSort || options.gowWclSort);
}

describe('wclSortEnabled', () => {
    it('uses the shared key when it has been written', () => {
        expect(wclSortEnabled({ wclSortByParse: true })).toBe(true);
        expect(wclSortEnabled({ wclSortByParse: false })).toBe(false);
    });

    it('lets an explicit false win over stale per-site keys', () => {
        // Someone who turns the new toggle off must not have it resurrected by
        // an old key still sitting in sync storage.
        expect(wclSortEnabled({ wclSortByParse: false, wpWclSort: true, rioWclSort: true })).toBe(false);
    });

    it('migrates from any single old per-site key', () => {
        expect(wclSortEnabled({ wpWclSort: true })).toBe(true);
        expect(wclSortEnabled({ rioWclSort: true })).toBe(true);
        expect(wclSortEnabled({ gowWclSort: true })).toBe(true);
    });

    it('stays off when every old key was off', () => {
        expect(wclSortEnabled({ wpWclSort: false, rioWclSort: false, gowWclSort: false })).toBe(false);
    });

    it('defaults to off for a fresh install with nothing saved', () => {
        expect(wclSortEnabled({})).toBe(false);
    });
});

// ─── Guilds of WoW M+ score parsing (guildsofwow.js) ─────────────────────────

function parseGowMythicPlusScore(text) {
    const match = (text ?? '').trim().match(/^[\d,]+/);
    if (!match) return null;
    const val = parseInt(match[0].replace(/,/g, ''), 10);
    return isNaN(val) ? null : val;
}

describe('Guilds of WoW M+ score parsing', () => {
    it('reads a bare current-season score', () => {
        expect(parseGowMythicPlusScore('2672')).toBe(2672);
    });

    it('reads a grouped past-season score without truncating at the comma', () => {
        // The card renders "2,245 HIGHEST SEASON"; parseInt() alone stops at
        // the comma and yields 2, which silently fails a min-score filter.
        expect(parseGowMythicPlusScore('2,245 HIGHEST SEASON')).toBe(2245);
        expect(parseGowMythicPlusScore('3,260 HIGHEST SEASON')).toBe(3260);
    });

    it('returns null when there is no score', () => {
        expect(parseGowMythicPlusScore('N/A')).toBe(null);
        expect(parseGowMythicPlusScore('')).toBe(null);
        expect(parseGowMythicPlusScore(null)).toBe(null);
    });

    it('never yields an implausibly small score for a real card', () => {
        for (const t of ['2672', '2,245 HIGHEST SEASON', '1018', '156', '3,280 HIGHEST SEASON'])
            expect(parseGowMythicPlusScore(t)).toBeGreaterThan(100);
    });
});

// ─── Spec table completeness ──────────────────────────────────────────────────
// Mirrors SPEC_ROLE in common.js. The whole point of the table is that it is
// COMPLETE, so these tests enumerate every spec in the game rather than
// spot-checking: a missing DPS spec makes roleFromText() blind to it, and a
// missing tank or healer makes specToRole() call them DPS.

const SPEC_ROLE = {
    blood: 'tank', vengeance: 'tank', guardian: 'tank', brewmaster: 'tank',
    protection: 'tank',
    restoration: 'healer', preservation: 'healer', mistweaver: 'healer',
    holy: 'healer', discipline: 'healer',
    frost: 'dps', unholy: 'dps', havoc: 'dps', balance: 'dps', feral: 'dps',
    devastation: 'dps', augmentation: 'dps', marksmanship: 'dps', survival: 'dps',
    arcane: 'dps', fire: 'dps', windwalker: 'dps', retribution: 'dps',
    shadow: 'dps', assassination: 'dps', outlaw: 'dps', subtlety: 'dps',
    elemental: 'dps', enhancement: 'dps', affliction: 'dps', demonology: 'dps',
    destruction: 'dps', arms: 'dps', fury: 'dps',
    'beast mastery': 'dps',
};

function specToRole(spec) {
    if (!spec) return null;
    return SPEC_ROLE[spec.trim().toLowerCase()] ?? 'dps';
}

function roleFromSpecName(spec) {
    if (!spec) return null;
    return SPEC_ROLE[spec.trim().toLowerCase()] ?? null;
}

function roleFromText(text) {
    if (!text) return null;
    const lower = String(text).toLowerCase();
    if (/\b(healer|healers|healing|heals)\b/.test(lower)) return 'healer';
    if (/\b(tank|tanks|tanking)\b/.test(lower))           return 'tank';
    if (/\b(dps|damage|ranged|melee)\b/.test(lower))      return 'dps';
    if (lower.includes('beast mastery')) return 'dps';
    for (const word of lower.split(/[^a-z]+/)) {
        const role = roleFromSpecName(word);
        if (role) return role;
    }
    return null;
}

// Every spec in the game, by class, with the role it actually plays.
const ALL_SPECS = [
    ['Death Knight', 'Blood', 'tank'], ['Death Knight', 'Frost', 'dps'], ['Death Knight', 'Unholy', 'dps'],
    ['Demon Hunter', 'Havoc', 'dps'], ['Demon Hunter', 'Vengeance', 'tank'],
    ['Druid', 'Balance', 'dps'], ['Druid', 'Feral', 'dps'], ['Druid', 'Guardian', 'tank'],
    ['Druid', 'Restoration', 'healer'],
    ['Evoker', 'Devastation', 'dps'], ['Evoker', 'Preservation', 'healer'], ['Evoker', 'Augmentation', 'dps'],
    ['Hunter', 'Beast Mastery', 'dps'], ['Hunter', 'Marksmanship', 'dps'], ['Hunter', 'Survival', 'dps'],
    ['Mage', 'Arcane', 'dps'], ['Mage', 'Fire', 'dps'], ['Mage', 'Frost', 'dps'],
    ['Monk', 'Brewmaster', 'tank'], ['Monk', 'Mistweaver', 'healer'], ['Monk', 'Windwalker', 'dps'],
    ['Paladin', 'Holy', 'healer'], ['Paladin', 'Protection', 'tank'], ['Paladin', 'Retribution', 'dps'],
    ['Priest', 'Discipline', 'healer'], ['Priest', 'Holy', 'healer'], ['Priest', 'Shadow', 'dps'],
    ['Rogue', 'Assassination', 'dps'], ['Rogue', 'Outlaw', 'dps'], ['Rogue', 'Subtlety', 'dps'],
    ['Shaman', 'Elemental', 'dps'], ['Shaman', 'Enhancement', 'dps'], ['Shaman', 'Restoration', 'healer'],
    ['Warlock', 'Affliction', 'dps'], ['Warlock', 'Demonology', 'dps'], ['Warlock', 'Destruction', 'dps'],
    ['Warrior', 'Arms', 'dps'], ['Warrior', 'Fury', 'dps'], ['Warrior', 'Protection', 'tank'],
];

describe('SPEC_ROLE completeness', () => {
    it('maps every spec of every class to its real role', () => {
        for (const [cls, spec, role] of ALL_SPECS) {
            expect(specToRole(spec), `${cls} ${spec}`).toBe(role);
        }
    });

    it('recognises every spec by name, with no gaps', () => {
        // roleFromSpecName returning null for a real spec is the bug this guards:
        // it would make roleFromText() silently blind to that spec.
        for (const [cls, spec] of ALL_SPECS) {
            expect(roleFromSpecName(spec), `${cls} ${spec} is a known spec`).toBeTruthy();
        }
    });

    it('covers every tank and healer spec, so neither can be mistaken for DPS', () => {
        const tanks = ALL_SPECS.filter(([, , r]) => r === 'tank').map(([, s]) => s);
        const heals = ALL_SPECS.filter(([, , r]) => r === 'healer').map(([, s]) => s);
        for (const s of tanks) expect(specToRole(s), s).toBe('tank');
        for (const s of heals) expect(specToRole(s), s).toBe('healer');
        // Five distinct tank spec names and five healer ones across all classes.
        expect(new Set(tanks).size).toBe(5);
        expect(new Set(heals).size).toBe(5);
    });

    it('resolves specs shared between classes to one unambiguous role', () => {
        expect(specToRole('Restoration')).toBe('healer');  // druid + shaman
        expect(specToRole('Holy')).toBe('healer');         // paladin + priest
        expect(specToRole('Protection')).toBe('tank');     // paladin + warrior
        expect(specToRole('Frost')).toBe('dps');           // death knight + mage
    });
});

describe('specToRole vs roleFromSpecName', () => {
    it('differ only on unknown input, which is the whole point', () => {
        // specToRole is for callers who already know the string is a spec.
        expect(specToRole('Elemental')).toBe('dps');
        expect(roleFromSpecName('Elemental')).toBe('dps');
        // roleFromSpecName is for callers scanning arbitrary text.
        expect(specToRole('Recruiting')).toBe('dps');
        expect(roleFromSpecName('Recruiting')).toBe(null);
        expect(specToRole('')).toBe(null);
        expect(roleFromSpecName('')).toBe(null);
    });
});

describe('roleFromText', () => {
    it('returns null when there is no role or spec to find', () => {
        expect(roleFromText(null)).toBe(null);
        expect(roleFromText('')).toBe(null);
        expect(roleFromText('Recruiting for Heroic progression')).toBe(null);
        expect(roleFromText('Tuesday 20:00 server time')).toBe(null);
    });

    it('prefers an explicit role word over anything else', () => {
        expect(roleFromText('Healer')).toBe('healer');
        expect(roleFromText('Tank')).toBe('tank');
        expect(roleFromText('DPS')).toBe('dps');
        expect(roleFromText('Ranged')).toBe('dps');
        expect(roleFromText('Melee')).toBe('dps');
    });

    it('falls back to a spec name embedded in the text', () => {
        expect(roleFromText('Restoration Druid')).toBe('healer');
        expect(roleFromText('spec-icon protection-warrior')).toBe('tank');
        expect(roleFromText('Beast Mastery')).toBe('dps');
        expect(roleFromText('  Mistweaver  ')).toBe('healer');
    });

    it('is not fooled by a spec name appearing inside a longer word', () => {
        // Word-splitting, not substring matching: "Holyfield" is not a healer.
        expect(roleFromText('Holyfield')).toBe(null);
        expect(roleFromText('Frostmourne')).toBe(null);
    });

    it('never guesses DPS for text it does not understand', () => {
        // The old implementation returned 'dps' unconditionally, which scored
        // every unrecognised healer against a threshold they cannot meet.
        for (const text of ['', 'Guild', 'EU-Tarren Mill', '3/8 Mythic', 'Alliance']) {
            expect(roleFromText(text), text).toBe(null);
        }
    });
});

// ─── roleFromSpecText ─────────────────────────────────────────────────────────
// Spec-only scanning, used to sift CSS class names. Kept separate from
// roleFromText precisely so a "damage-meter" class cannot invent a role.

function roleFromSpecText(text) {
    if (!text) return null;
    const lower = String(text).toLowerCase();
    if (/beast[^a-z]+mastery/.test(lower)) return 'dps';
    for (const word of lower.split(/[^a-z]+/)) {
        const role = roleFromSpecName(word);
        if (role) return role;
    }
    return null;
}

describe('roleFromSpecText', () => {
    it('reads a spec out of a hyphenated or underscored CSS class', () => {
        expect(roleFromSpecText('player-character-spec spec-mistweaver')).toBe('healer');
        expect(roleFromSpecText('icon_blood_dk')).toBe('tank');
        expect(roleFromSpecText('spec--vengeance')).toBe('tank');
    });

    it('finds the only two-word spec despite the separator', () => {
        expect(roleFromSpecText('beast-mastery-icon')).toBe('dps');
        expect(roleFromSpecText('Beast Mastery')).toBe('dps');
        expect(roleFromSpecText('beast_mastery')).toBe('dps');
    });

    it('ignores explicit role words, unlike roleFromText', () => {
        // This is the whole reason the two functions are separate: these strings
        // are plausible CSS class names, not statements about a player's role.
        expect(roleFromSpecText('damage-meter-col')).toBe(null);
        expect(roleFromSpecText('ranged-column')).toBe(null);
        expect(roleFromSpecText('tank-icon')).toBe(null);
        expect(roleFromText('damage')).toBe('dps');
    });

    it('is not fooled by a spec name inside a longer word', () => {
        expect(roleFromSpecText('Frostmourne')).toBe(null);
        expect(roleFromSpecText('holyfield')).toBe(null);
    });

    it('returns null for empty input', () => {
        expect(roleFromSpecText('')).toBe(null);
        expect(roleFromSpecText(null)).toBe(null);
    });
});

// ─── getRecruitmentRole (warcraftlogs.js) ─────────────────────────────────────
// WCL's recruitment card markup is not confirmed, so the extractor tries several
// signals. These cover each strategy plus the cases that must NOT produce a role.
// Requires a DOM, so this suite runs under Vitest's jsdom environment.

function getRecruitmentRole(card) {
    for (const el of card.querySelectorAll('img[alt], [title], [aria-label]')) {
        const role = roleFromText(el.getAttribute('alt') || el.getAttribute('title') ||
                                 el.getAttribute('aria-label'));
        if (role) return role;
    }
    for (const el of card.querySelectorAll('[class*="spec"], [class*="role"]')) {
        const role = roleFromText(el.textContent);
        if (role) return role;
    }
    for (const el of card.querySelectorAll('[class]')) {
        if (typeof el.className !== 'string') continue;
        const role = roleFromSpecText(el.className);
        if (role) return role;
    }
    return null;
}

describe('getRecruitmentRole', () => {
    const card = html => {
        const el = document.createElement('div');
        el.innerHTML = html;
        return el;
    };

    it('reads a spec from an icon alt, title or aria-label', () => {
        expect(getRecruitmentRole(card('<img alt="Restoration" src="x.jpg">'))).toBe('healer');
        expect(getRecruitmentRole(card('<span title="Brewmaster"></span>'))).toBe('tank');
        expect(getRecruitmentRole(card('<div aria-label="Healer"></div>'))).toBe('healer');
    });

    it('reads a spec or role from a spec/role-named element', () => {
        expect(getRecruitmentRole(card('<div class="character-spec">Vengeance</div>'))).toBe('tank');
        expect(getRecruitmentRole(card('<div class="recruitment-role">Tank</div>'))).toBe('tank');
        expect(getRecruitmentRole(card('<div class="role-label">DPS</div>'))).toBe('dps');
    });

    it('reads a spec carried as a CSS class', () => {
        expect(getRecruitmentRole(card('<div class="player-character-spec spec-mistweaver"></div>')))
            .toBe('healer');
        expect(getRecruitmentRole(card('<div class="beast-mastery-icon"></div>'))).toBe('dps');
    });

    it('returns null rather than guessing DPS when the card does not say', () => {
        // The old implementation defaulted to 'dps', which scored every healer it
        // failed to recognise against a threshold no healer can meet.
        expect(getRecruitmentRole(card(
            '<span>Thrall</span><span>EU-Tarren Mill</span><span>3/8 Mythic</span>'))).toBe(null);
        expect(getRecruitmentRole(card('<span class="realm">Frostmourne</span>'))).toBe(null);
        expect(getRecruitmentRole(card('<div class="damage-meter-col"></div>'))).toBe(null);
    });

    it('prefers a real spec signal over class-name noise', () => {
        expect(getRecruitmentRole(card('<div class="damage-col"></div><img alt="Discipline">')))
            .toBe('healer');
    });
});
