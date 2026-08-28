// tests/wcl-api.test.js
// Unit tests for the pure response parsers in wcl-api.js. The module touches
// `chrome` and `fetch` only inside functions, so it imports cleanly in Node.
//
// These matter more than they look: role 'auto' issues one query for the dps
// metric and decides from the response whether a second hps query is needed.
// If extractSpec stops finding the spec in a zoneRankings blob, every healer
// silently gets judged on their damage parses.

import { describe, it, expect } from 'vitest';
import { extractScores, extractSpec, needsHpsFollowUp } from '../src/wcl-api.js';

// Shape of the zoneRankings JSON blob WarcraftLogs returns, trimmed to the
// fields we read.
function zoneRankings({ best = 82.5, median = 71.2, allStars, rankings } = {}) {
    return {
        bestPerformanceAverage:   best,
        medianPerformanceAverage: median,
        difficulty: 5,
        partition: 1,
        zone: 38,
        ...(allStars ? { allStars } : {}),
        ...(rankings ? { rankings } : {}),
    };
}

// ─── extractScores ────────────────────────────────────────────────────────────

describe('extractScores', () => {
    it('reads both performance averages', () => {
        expect(extractScores(zoneRankings())).toEqual({ best: 82.5, median: 71.2 });
    });
    it('returns nulls for a missing or non-object blob', () => {
        for (const input of [null, undefined, 'nope', 42]) {
            expect(extractScores(input)).toEqual({ best: null, median: null });
        }
    });
    it('returns nulls for an empty blob (character exists, no rankings)', () => {
        expect(extractScores({})).toEqual({ best: null, median: null });
    });
    it('ignores non-numeric values rather than passing them through', () => {
        expect(extractScores({ bestPerformanceAverage: null, medianPerformanceAverage: '71' }))
            .toEqual({ best: null, median: null });
    });
    it('keeps a genuine zero rather than nulling it', () => {
        expect(extractScores(zoneRankings({ best: 0, median: 0 })))
            .toEqual({ best: 0, median: 0 });
    });
});

// ─── extractSpec ──────────────────────────────────────────────────────────────

describe('extractSpec', () => {
    it('reads the spec from allStars', () => {
        expect(extractSpec(zoneRankings({ allStars: [{ spec: 'Havoc', points: 1 }] }))).toBe('Havoc');
    });
    it('prefers allStars over per-encounter rankings', () => {
        const blob = zoneRankings({
            allStars: [{ spec: 'Restoration' }],
            rankings: [{ bestSpec: 'Balance' }],
        });
        expect(extractSpec(blob)).toBe('Restoration');
    });
    it('falls back to rankings[].bestSpec when allStars is absent', () => {
        const blob = zoneRankings({ rankings: [{ encounter: { id: 1 }, bestSpec: 'Frost' }] });
        expect(extractSpec(blob)).toBe('Frost');
    });
    it('falls back to rankings[].spec when bestSpec is absent', () => {
        expect(extractSpec(zoneRankings({ rankings: [{ spec: 'Vengeance' }] }))).toBe('Vengeance');
    });
    it('skips entries that carry no spec at all', () => {
        const blob = zoneRankings({
            allStars: [{ points: 0 }],
            rankings: [{ encounter: { id: 1 } }, { bestSpec: 'Mistweaver' }],
        });
        expect(extractSpec(blob)).toBe('Mistweaver');
    });
    it('returns null when nothing reports a spec', () => {
        expect(extractSpec(zoneRankings())).toBeNull();
        expect(extractSpec(zoneRankings({ allStars: [], rankings: [] }))).toBeNull();
    });
    it('returns null for a missing or malformed blob', () => {
        for (const input of [null, undefined, {}, 'nope', { allStars: 'not-an-array' }]) {
            expect(extractSpec(input)).toBeNull();
        }
    });
});

// ─── needsHpsFollowUp ─────────────────────────────────────────────────────────

describe('needsHpsFollowUp', () => {
    const scored  = { best: 82.5, median: 71.2 };
    const noData  = { best: null, median: null };

    it('follows up for a healer spec — damage percentiles are the wrong numbers', () => {
        expect(needsHpsFollowUp('healer', 'Restoration', scored)).toBe(true);
    });
    it('does not follow up for dps or tank specs', () => {
        expect(needsHpsFollowUp('dps',  'Havoc',      scored)).toBe(false);
        expect(needsHpsFollowUp('tank', 'Protection', scored)).toBe(false);
    });
    it('follows up when the dps response told us nothing at all', () => {
        // Either a character with no logs, or a healer with no damage rankings.
        // Guessing DPS here is the one wrong answer that matters.
        expect(needsHpsFollowUp(null, null, noData)).toBe(true);
    });
    it('does not follow up when there are scores but no spec', () => {
        // They logged damage, so the dps numbers are real — no reason to pay
        // for a second request.
        expect(needsHpsFollowUp(null, null, scored)).toBe(false);
        expect(needsHpsFollowUp(null, null, { best: 40, median: null })).toBe(false);
    });
    it('does not follow up when a non-healer spec is known but unranked', () => {
        expect(needsHpsFollowUp('dps', 'Havoc', noData)).toBe(false);
    });
    it('treats a zero parse as data, not as nothing', () => {
        expect(needsHpsFollowUp(null, null, { best: 0, median: 0 })).toBe(false);
    });
});
