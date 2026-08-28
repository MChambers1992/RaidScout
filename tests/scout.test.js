// tests/scout.test.js
// Unit tests for the scout decision logic. Unlike common.test.js (which inlines
// its copies because content scripts aren't modules), this imports src/scout.js
// directly — it is a plain ES module with no browser globals.

import { describe, it, expect } from 'vitest';
import {
    roleForSpec,
    thresholdsForRole,
    failsWclThresholds,
    buildScoutThresholds,
    scoutVerdict,
    characterFromWclUrl,
    buildWclCharacterUrl,
} from '../src/scout.js';

// ─── roleForSpec ──────────────────────────────────────────────────────────────

describe('roleForSpec', () => {
    it('returns null when no spec is known', () => {
        expect(roleForSpec(null)).toBeNull();
        expect(roleForSpec('')).toBeNull();
        expect(roleForSpec(undefined)).toBeNull();
    });
    it('maps healer specs', () => {
        for (const spec of ['Restoration', 'Holy', 'Discipline', 'Mistweaver', 'Preservation']) {
            expect(roleForSpec(spec)).toBe('healer');
        }
    });
    it('maps tank specs', () => {
        for (const spec of ['Protection', 'Guardian', 'Blood', 'Brewmaster', 'Vengeance']) {
            expect(roleForSpec(spec)).toBe('tank');
        }
    });
    it('maps everything else to dps', () => {
        for (const spec of ['Havoc', 'Fire', 'Augmentation', 'Feral', 'Frost', 'Unholy']) {
            expect(roleForSpec(spec)).toBe('dps');
        }
    });
    it('is case and whitespace insensitive', () => {
        expect(roleForSpec('  restoration ')).toBe('healer');
        expect(roleForSpec('BREWMASTER')).toBe('tank');
    });
});

// ─── thresholdsForRole ────────────────────────────────────────────────────────

const settings = {
    minBest: 60, minMedian: 50,
    minBestHealer: 80, minMedianHealer: 70,
    minBestTank: 0, minMedianTank: 0,
    hideUnknown: false,
};

describe('thresholdsForRole', () => {
    it('uses the DPS pair for dps and unknown roles', () => {
        expect(thresholdsForRole('dps', settings)).toMatchObject({ minBest: 60, minMedian: 50 });
        expect(thresholdsForRole(undefined, settings)).toMatchObject({ minBest: 60, minMedian: 50 });
    });
    it('uses the healer pair for healers', () => {
        expect(thresholdsForRole('healer', settings)).toMatchObject({ minBest: 80, minMedian: 70 });
    });
    it('falls back to the DPS pair for tanks with no tank override', () => {
        expect(thresholdsForRole('tank', settings)).toMatchObject({ minBest: 60, minMedian: 50 });
    });
    it('uses the tank override when set', () => {
        const withTank = { ...settings, minBestTank: 30, minMedianTank: 25 };
        expect(thresholdsForRole('tank', withTank)).toMatchObject({ minBest: 30, minMedian: 25 });
    });
});

// ─── failsWclThresholds (mirror of common.js) ─────────────────────────────────

describe('failsWclThresholds', () => {
    it('hides a DPS below the DPS thresholds', () => {
        expect(failsWclThresholds({ best: 40, median: 30 }, settings, 'dps')).toBe(true);
    });
    it('does not hide a healer judged against healer thresholds they meet', () => {
        expect(failsWclThresholds({ best: 85, median: 75 }, settings, 'healer')).toBe(false);
    });
    it('hides a healer below the healer thresholds even when they clear the DPS ones', () => {
        expect(failsWclThresholds({ best: 65, median: 55 }, settings, 'healer')).toBe(true);
    });
    it('fails open on transient errors', () => {
        expect(failsWclThresholds({ best: null, median: null, error: 'CLOUDFLARE_BLOCKED:300' }, settings, 'dps')).toBe(false);
        expect(failsWclThresholds({ best: null, median: null, error: 'NO_CREDENTIALS' }, settings, 'dps')).toBe(false);
    });
    it('honours hideUnknown for characters with no logs', () => {
        const score = { best: null, median: null, notFound: true };
        expect(failsWclThresholds(score, settings, 'dps')).toBe(false);
        expect(failsWclThresholds(score, { ...settings, hideUnknown: true }, 'dps')).toBe(true);
    });
});

// ─── buildScoutThresholds ─────────────────────────────────────────────────────

describe('buildScoutThresholds', () => {
    it('maps storage keys onto threshold fields', () => {
        expect(buildScoutThresholds({
            bestParseThreshold: 60, parseThreshold: 50,
            wclMinBestHealer: 80, wclMinMedianHealer: 70,
            wclMinBestTank: 30, wclMinMedianTank: 25,
            wclHideUnknown: true,
        })).toEqual({
            minBest: 60, minMedian: 50,
            minBestHealer: 80, minMedianHealer: 70,
            minBestTank: 30, minMedianTank: 25,
            hideUnknown: true,
        });
    });
    it('defaults every threshold to 0 on an empty snapshot', () => {
        expect(buildScoutThresholds({})).toEqual({
            minBest: 0, minMedian: 0,
            minBestHealer: 0, minMedianHealer: 0,
            minBestTank: 0, minMedianTank: 0,
            hideUnknown: false,
        });
    });
    it('tolerates being called with no arguments', () => {
        expect(buildScoutThresholds().minBest).toBe(0);
    });
});

// ─── scoutVerdict ─────────────────────────────────────────────────────────────

describe('scoutVerdict', () => {
    it('opens a candidate that clears the thresholds', () => {
        expect(scoutVerdict({ best: 90, median: 80 }, settings, 'dps'))
            .toEqual({ verdict: 'open', reason: 'PASSED' });
    });
    it('rejects a candidate below the thresholds', () => {
        expect(scoutVerdict({ best: 20, median: 15 }, settings, 'dps'))
            .toEqual({ verdict: 'reject', reason: 'BELOW_THRESHOLD' });
    });
    it('uses the role passed in, so a healer is judged on HPS thresholds', () => {
        expect(scoutVerdict({ best: 65, median: 55 }, settings, 'healer').verdict).toBe('reject');
        expect(scoutVerdict({ best: 65, median: 55 }, settings, 'dps').verdict).toBe('open');
    });
    it('is unknown (fails open) on any API error', () => {
        for (const error of ['NO_CREDENTIALS', 'RATE_LIMITED:60', 'CLOUDFLARE_BLOCKED:300', 'FETCH_TIMEOUT']) {
            expect(scoutVerdict({ best: null, median: null, error }, settings, 'dps'))
                .toEqual({ verdict: 'unknown', reason: error });
        }
    });
    it('is unknown when there is no score at all', () => {
        expect(scoutVerdict(null, settings, 'dps').verdict).toBe('unknown');
    });
    it('opens characters with no logs unless hideUnknown is set', () => {
        const score = { best: null, median: null, notFound: true };
        expect(scoutVerdict(score, settings, 'dps')).toEqual({ verdict: 'open', reason: 'NO_LOGS' });
        expect(scoutVerdict(score, { ...settings, hideUnknown: true }, 'dps'))
            .toEqual({ verdict: 'reject', reason: 'NO_LOGS' });
    });
    it('opens when every threshold is disabled', () => {
        expect(scoutVerdict({ best: 1, median: 1 }, buildScoutThresholds({}), 'dps').verdict).toBe('open');
    });
});

// ─── characterFromWclUrl ──────────────────────────────────────────────────────

describe('characterFromWclUrl', () => {
    it('parses a standard character URL', () => {
        expect(characterFromWclUrl('https://www.warcraftlogs.com/character/eu/kazzak/heroname'))
            .toEqual({ region: 'eu', realm: 'kazzak', name: 'heroname' });
    });
    it('lowercases region and realm but preserves name casing', () => {
        const c = characterFromWclUrl('https://www.warcraftlogs.com/character/US/Area-52/Hero');
        expect(c).toEqual({ region: 'us', realm: 'area-52', name: 'Hero' });
    });
    it('decodes and hyphenates multi-word realms', () => {
        const c = characterFromWclUrl('https://www.warcraftlogs.com/character/eu/Twisting%20Nether/Hero');
        expect(c.realm).toBe('twisting-nether');
    });
    it('decodes non-ASCII character names', () => {
        expect(characterFromWclUrl('https://www.warcraftlogs.com/character/eu/kazzak/Sh%C3%A1dow').name)
            .toBe('Shádow');
    });
    it('strips a query string from the name', () => {
        expect(characterFromWclUrl('https://www.warcraftlogs.com/character/eu/kazzak/hero?spec=1').name)
            .toBe('hero');
    });
    it('returns null for non-character URLs', () => {
        expect(characterFromWclUrl('https://www.warcraftlogs.com/guild/eu/kazzak/myguild')).toBeNull();
        expect(characterFromWclUrl('https://www.warcraftlogs.com/zone/rankings/38')).toBeNull();
        expect(characterFromWclUrl('https://www.warcraftlogs.com/character/eu/kazzak')).toBeNull();
    });
    it('returns null for malformed input', () => {
        expect(characterFromWclUrl('not a url')).toBeNull();
        expect(characterFromWclUrl(null)).toBeNull();
    });
});

// ─── buildWclCharacterUrl ─────────────────────────────────────────────────────

describe('buildWclCharacterUrl', () => {
    it('builds a canonical character URL', () => {
        expect(buildWclCharacterUrl({ region: 'EU', realm: 'Kazzak', name: 'Hero' }))
            .toBe('https://www.warcraftlogs.com/character/eu/kazzak/Hero');
    });
    it('hyphenates realms with spaces', () => {
        expect(buildWclCharacterUrl({ region: 'eu', realm: 'Twisting Nether', name: 'Hero' }))
            .toBe('https://www.warcraftlogs.com/character/eu/twisting-nether/Hero');
    });
    it('round-trips with characterFromWclUrl', () => {
        const url = buildWclCharacterUrl({ region: 'us', realm: 'area-52', name: 'Hero' });
        expect(characterFromWclUrl(url)).toEqual({ region: 'us', realm: 'area-52', name: 'Hero' });
    });
    it('returns null when part of the identity is missing', () => {
        expect(buildWclCharacterUrl({ region: 'eu', realm: 'kazzak' })).toBeNull();
        expect(buildWclCharacterUrl({})).toBeNull();
    });
});
