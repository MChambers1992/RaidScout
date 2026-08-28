// tests/common.test.js
// Unit tests for pure logic extracted from common.js and wcl-api.js.
// These run in Node (via Vitest) with no browser globals needed.

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

function failsWclThresholds(score, { minBest, minMedian, hideUnknown }) {
    if (!score) return !!hideUnknown;
    if (score.error) return false;
    const haveData = score.best !== null || score.median !== null;
    if (!haveData) return !!hideUnknown;
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
    const cfg = { minBest: 60, minMedian: 50, hideUnknown: false };

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
    it('respects hideUnknown=false for characters with no logs', () => {
        expect(failsWclThresholds({ best: null, median: null, notFound: true }, cfg)).toBe(false);
    });
    it('respects hideUnknown=true for characters with no logs', () => {
        expect(failsWclThresholds({ best: null, median: null, notFound: true }, { ...cfg, hideUnknown: true })).toBe(true);
    });
    it('respects hideUnknown=true for null score object', () => {
        expect(failsWclThresholds(null, { ...cfg, hideUnknown: true })).toBe(true);
    });
    it('keeps on null score when hideUnknown=false', () => {
        expect(failsWclThresholds(null, cfg)).toBe(false);
    });
    it('handles one metric present: best ok, median null → keep', () => {
        expect(failsWclThresholds({ best: 80, median: null }, cfg)).toBe(false);
    });
    it('handles one metric present: median below, best null → hide', () => {
        expect(failsWclThresholds({ best: null, median: 30 }, cfg)).toBe(true);
    });
    it('disabled thresholds (0) never hide', () => {
        expect(failsWclThresholds({ best: 5, median: 5 }, { minBest: 0, minMedian: 0, hideUnknown: false })).toBe(false);
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
        const cfg = { minBest: 1, minMedian: 0, hideUnknown: false };
        expect(failsWclThresholds({ best: 0, median: 50 }, cfg)).toBe(true);
    });
    it('failsWclThresholds: score with best=100 is perfect and kept', () => {
        const cfg = { minBest: 99, minMedian: 99, hideUnknown: false };
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
        return { minBest: settings.minBestHealer || 0, minMedian: settings.minMedianHealer || 0, hideUnknown: settings.hideUnknown };
    }
    if (role === 'tank') {
        return { minBest: settings.minBestTank || settings.minBest || 0, minMedian: settings.minMedianTank || settings.minMedian || 0, hideUnknown: settings.hideUnknown };
    }
    return { minBest: settings.minBest || 0, minMedian: settings.minMedian || 0, hideUnknown: settings.hideUnknown };
}

function failsWclThresholdsRoleAware(score, settings, role) {
    const { minBest, minMedian, hideUnknown } = thresholdsForRole(role || 'dps', settings);
    if (!score) return !!hideUnknown;
    if (score.error) return false;
    const haveData = score.best !== null || score.median !== null;
    if (!haveData) return !!hideUnknown;
    if (minBest   > 0 && score.best   !== null && score.best   < minBest)   return true;
    if (minMedian > 0 && score.median !== null && score.median < minMedian) return true;
    return false;
}

describe('thresholdsForRole', () => {
    const settings = {
        minBest: 60, minMedian: 50,
        minBestHealer: 70, minMedianHealer: 65,
        minBestTank: 40, minMedianTank: 35,
        hideUnknown: false,
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
        hideUnknown: false,
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
            name:   decodeURIComponent(parts[idx + 3].split('?')[0]),
            role:   'auto',
        };
    } catch { return null; }
}

describe('extractCharacterFromUrl', () => {
    it('parses a standard WCL character URL', () => {
        const c = extractCharacterFromUrl('https://www.warcraftlogs.com/character/eu/kazzak/heroname');
        expect(c).toEqual({ region: 'eu', realm: 'kazzak', name: 'heroname', role: 'auto' });
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
