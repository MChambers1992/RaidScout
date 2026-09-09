// tests/common.test.js
// The shared content-script helpers, exercised as the code that actually ships.
//
// common.js is a classic script injected before every site script, so it has no
// export surface. It is evaluated into a jsdom window here (the approach
// tests/links.test.js uses) rather than re-declared: the copies these tests used
// to run against had already drifted — failsWclThresholds was still the
// pre-1.4 two-argument form the source no longer has, so the role-aware
// behaviour the extension really ships was never the thing under test.
//
// Its top-level declarations are function declarations, so they land on the
// window; a trailing assignment hands the set out in one go.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const commonSource = readFileSync(new URL('../src/content/common.js', import.meta.url), 'utf8');

const EXPOSED = [
    'normalizeClassName', 'hasNoWclLogs', 'failsWclThresholds', 'thresholdsForRole',
    'wclSortEnabled', 'effectiveRole', 'badgeStateForScore', 'buildWclSettings',
    'roleForSpec', 'isCloudflareChallengePage',
];

const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
dom.window.eval(`${commonSource}\n;window.__api = { ${EXPOSED.join(', ')} };`);

const {
    normalizeClassName, hasNoWclLogs, failsWclThresholds, thresholdsForRole,
    wclSortEnabled, effectiveRole, badgeStateForScore, buildWclSettings,
    roleForSpec, isCloudflareChallengePage,
} = dom.window.__api;

// ─── Still mirrored, deliberately ─────────────────────────────────────────────
// These two live in wcl-api.js and are not exported. tests/wcl-api.test.js
// covers the real ones through their observable effects (which metric the query
// asks for, and that a cache entry is keyed by role); the copies below only
// pin the shapes those tests rely on.

function roleToMetric(role) {
    if (role === 'healer') return 'hps';
    return 'dps';
}

function characterKey({ region, realm, name, role }) {
    return `${region}/${realm}/${name}/${role || 'dps'}`.toLowerCase();
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
        expect(failsWclThresholds({ best: 75, median: 70 }, settings, 'healer')).toBe(false);
    });
    it('healer with 65/60 HPS fails healer thresholds (minBestHealer=70)', () => {
        expect(failsWclThresholds({ best: 65, median: 60 }, settings, 'healer')).toBe(true);
    });
    it('healer with 65/60 HPS would PASS dps thresholds — proving role isolation', () => {
        expect(failsWclThresholds({ best: 65, median: 60 }, settings, 'dps')).toBe(false);
    });
    it('tank with no tank-specific thresholds falls back to DPS thresholds', () => {
        expect(failsWclThresholds({ best: 50, median: 40 }, settings, 'tank')).toBe(true);
    });
    it('dps at exactly DPS thresholds passes', () => {
        expect(failsWclThresholds({ best: 60, median: 50 }, settings, 'dps')).toBe(false);
    });
    it('error is always fail-open regardless of role', () => {
        expect(failsWclThresholds({ best: null, median: null, error: 'TIMEOUT' }, settings, 'healer')).toBe(false);
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
            expect(failsWclThresholds(
                { best: null, median: null, notFound: true }, settings, role)).toBe(true);
        });

        it(`keeps an errored lookup for a ${role ?? 'unknown-role'} character`, () => {
            expect(failsWclThresholds(
                { best: null, median: null, error: 'RATE_LIMITED:60' }, settings, role)).toBe(false);
        });
    }
});

// ─── Shared sort preference + migration ──────────────────────────────────────
// Sorting by parse used to be three
// per-site keys; it is now one. Installs that set the old keys must keep the
// behaviour they chose without touching settings again.

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


// ─── roleForSpec ──────────────────────────────────────────────────────────────
// The real function from common.js, evaluated above. There are three copies of
// this map (common.js, preflight.js, and the resolution in wcl-api.js) because
// none of those three files can import from the others; tests/preflight.test.js
// pins its own. Raider.IO's role column is gone, so this map is now the only
// thing standing between a healer and being judged on DPS parses.

describe('roleForSpec', () => {
    it('reads the healer specs', () => {
        for (const spec of ['Restoration', 'Holy', 'Discipline', 'Mistweaver', 'Preservation']) {
            expect(roleForSpec(spec)).toBe('healer');
        }
    });

    it('reads the tank specs', () => {
        for (const spec of ['Protection', 'Guardian', 'Blood', 'Brewmaster', 'Vengeance']) {
            expect(roleForSpec(spec)).toBe('tank');
        }
    });

    it('treats every other spec as DPS, including ones added since', () => {
        // Devourer and Augmentation are both live on Raider.IO's listing today
        // and neither heals nor tanks, so falling through to dps is right.
        for (const spec of ['Arms', 'Havoc', 'Devourer', 'Augmentation', 'Devastation', 'Frost']) {
            expect(roleForSpec(spec)).toBe('dps');
        }
    });

    it('covers every spec Raider.IO currently publishes on its recruitment listing', () => {
        // Captured from a live harvest: 30 distinct specs across 100 rows. Any
        // of them returning null would mean a row scored against the wrong metric.
        const live = ['Arcane', 'Arms', 'Assassination', 'Augmentation', 'Balance', 'Beast Mastery',
            'Blood', 'Brewmaster', 'Demonology', 'Destruction', 'Devastation', 'Devourer', 'Elemental',
            'Enhancement', 'Frost', 'Fury', 'Guardian', 'Havoc', 'Holy', 'Marksmanship', 'Mistweaver',
            'Protection', 'Restoration', 'Retribution', 'Shadow', 'Subtlety', 'Survival', 'Unholy',
            'Vengeance', 'Windwalker'];
        expect(live.filter(s => !['dps', 'tank', 'healer'].includes(roleForSpec(s)))).toEqual([]);
    });

    it('is null for an unknown spec rather than a guessed dps', () => {
        // The caller sends 'auto' on null and lets WarcraftLogs resolve it.
        expect(roleForSpec(null)).toBeNull();
        expect(roleForSpec('')).toBeNull();
    });

    it('is case- and whitespace-insensitive, matching what a title attribute carries', () => {
        expect(roleForSpec('  restoration ')).toBe('healer');
    });
});


// ─── isCloudflareChallengePage ────────────────────────────────────────────────
// Cloudflare serves its challenge at the requested page's own URL, so a content
// script matched on that URL runs against the interstitial instead of the site.
// Without this check every selector on the page is missing and the extension
// reports "site markup may have changed" — sending the user after a broken
// selector when the page simply had not loaded yet.
//
// The real function from common.js is evaluated in jsdom above, but it reads the
// live `document`, so each case gets its own DOM rather than the shared one.

describe('isCloudflareChallengePage', () => {
    // Runs the real function against a throwaway document.
    function inPage(html, title = '') {
        const page = new JSDOM(`<!doctype html><head><title>${title}</title></head><body>${html}</body>`,
                               { runScripts: 'outside-only' });
        page.window.eval(`${commonSource}
;window.__r = isCloudflareChallengePage();`);
        return page.window.__r;
    }

    it('recognises the title both blocked sites actually serve', () => {
        // Captured from live requests to wowprogress.com and warcraftlogs.com,
        // which both answer 403 with exactly this title.
        expect(inPage('', 'Just a moment...')).toBe(true);
        expect(inPage('', 'Attention Required! | Cloudflare')).toBe(true);
    });

    it('recognises the challenge markers regardless of title', () => {
        expect(inPage('<div id="challenge-running"></div>')).toBe(true);
        expect(inPage('<div id="cf-challenge-running"></div>')).toBe(true);
        expect(inPage('<h1 id="challenge-error-title">Error</h1>')).toBe(true);
        expect(inPage('<script src="https://x/cdn-cgi/challenge-platform/h/b/orchestrate"></script>')).toBe(true);
    });

    it('does not fire on the real listing page', () => {
        // The case that matters most: a false positive here would silently stop
        // filtering on a page that is working perfectly well.
        expect(inPage('<div class="ratingContainer"><table class="rating"></table></div>',
                      'WoWProgress: Gear Score Rating')).toBe(false);
    });

    it('does not fire on a page that merely mentions the words', () => {
        expect(inPage('<p>Just a moment while we load your logs</p>', 'Guild recruitment')).toBe(false);
    });

    it('tolerates a page with no title at all', () => {
        expect(inPage('<div></div>')).toBe(false);
    });
});
