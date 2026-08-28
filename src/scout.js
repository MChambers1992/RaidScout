// scout.js — pure decision logic for the scout flow.
//
// "Scouting" is the reactive flow: you land on a candidate's page (WoWProgress
// or Raider.IO) and RaidScout decides whether they are worth a look on
// WarcraftLogs. Historically that decision was made *after* opening a WCL tab
// and reading the rendered page, which meant every candidate — including the
// ones about to be rejected — had to get through WarcraftLogs' Cloudflare
// checks first. Everything here exists so the decision can be made in the
// service worker *before* a tab is ever created.
//
// This file is an ES module imported by the background service worker and by
// the unit tests. Content scripts cannot import modules, so `common.js` keeps
// its own copy of thresholdsForRole/failsWclThresholds — the two must stay in
// sync (tests/common.test.js pins the shared behaviour).

// ─── Spec → role ───────────────────────────────────────────────────────────────
// WarcraftLogs reports the spec a character ranked as (e.g. "Restoration",
// "Vengeance"). Spec names are unambiguous across classes for role purposes:
// both Restoration specs heal, both Protection specs tank, and so on.

const HEALER_SPECS = new Set([
    'restoration', 'holy', 'discipline', 'mistweaver', 'preservation',
]);

const TANK_SPECS = new Set([
    'protection', 'guardian', 'blood', 'brewmaster', 'vengeance',
]);

function roleForSpec(spec) {
    if (!spec) return null;
    const s = String(spec).trim().toLowerCase();
    if (HEALER_SPECS.has(s)) return 'healer';
    if (TANK_SPECS.has(s))   return 'tank';
    return 'dps';
}

// ─── Thresholds ────────────────────────────────────────────────────────────────
// Mirror of the same functions in src/content/common.js.

function thresholdsForRole(role, settings) {
    if (role === 'healer') {
        return {
            minBest:     settings.minBestHealer   || 0,
            minMedian:   settings.minMedianHealer || 0,
            hideUnknown: settings.hideUnknown,
        };
    }
    if (role === 'tank') {
        return {
            minBest:     settings.minBestTank   || settings.minBest   || 0,
            minMedian:   settings.minMedianTank || settings.minMedian || 0,
            hideUnknown: settings.hideUnknown,
        };
    }
    return {
        minBest:     settings.minBest   || 0,
        minMedian:   settings.minMedian || 0,
        hideUnknown: settings.hideUnknown,
    };
}

function failsWclThresholds(score, settings, role) {
    const { minBest, minMedian, hideUnknown } = thresholdsForRole(role || 'dps', settings);
    if (!score) return !!hideUnknown;
    if (score.error) return false;                          // transient failure → keep
    const haveData = score.best !== null || score.median !== null;
    if (!haveData) return !!hideUnknown;
    if (minBest   > 0 && score.best   !== null && score.best   < minBest)   return true;
    if (minMedian > 0 && score.median !== null && score.median < minMedian) return true;
    return false;
}

// Build the role-aware threshold object from a chrome.storage.sync snapshot.
// Same shape as common.js's buildWclSettings (minus the content-script-only
// concurrency field).
function buildScoutThresholds(options = {}) {
    return {
        minBest:         parseInt(options.bestParseThreshold) || 0,
        minMedian:       parseInt(options.parseThreshold)     || 0,
        minBestHealer:   parseInt(options.wclMinBestHealer)   || 0,
        minMedianHealer: parseInt(options.wclMinMedianHealer) || 0,
        minBestTank:     parseInt(options.wclMinBestTank)     || 0,
        minMedianTank:   parseInt(options.wclMinMedianTank)   || 0,
        hideUnknown:     !!options.wclHideUnknown,
    };
}

// ─── Verdict ───────────────────────────────────────────────────────────────────
// 'open'    — worth a tab
// 'reject'  — below the configured thresholds, don't open anything
// 'unknown' — we could not decide (no credentials, API error, rate limit,
//             Cloudflare challenge). Always fails open: the caller falls back
//             to the original open-then-check behaviour.

function scoutVerdict(score, settings, role) {
    if (!score)               return { verdict: 'unknown', reason: 'NO_SCORE' };
    if (score.error)          return { verdict: 'unknown', reason: score.error };

    const haveData = score.best !== null || score.median !== null;
    if (!haveData) {
        return settings.hideUnknown
            ? { verdict: 'reject', reason: 'NO_LOGS' }
            : { verdict: 'open',   reason: 'NO_LOGS' };
    }

    return failsWclThresholds(score, settings, role)
        ? { verdict: 'reject', reason: 'BELOW_THRESHOLD' }
        : { verdict: 'open',   reason: 'PASSED' };
}

// ─── WarcraftLogs character URLs ───────────────────────────────────────────────

const WCL_ORIGIN = 'https://www.warcraftlogs.com';

// Parse a WCL character URL into the identity tuple the API client wants.
// Returns null for anything that isn't a character URL (guild/zone/report pages).
function characterFromWclUrl(url) {
    try {
        const parts = new URL(url).pathname.split('/').filter(Boolean);
        const idx = parts.indexOf('character');
        if (idx === -1 || parts.length < idx + 4) return null;
        const region = parts[idx + 1];
        const realm  = parts[idx + 2];
        const name   = parts[idx + 3];
        if (!region || !realm || !name) return null;
        return {
            region: region.toLowerCase(),
            realm:  decodeURIComponent(realm).replace(/\s/g, '-').toLowerCase(),
            name:   decodeURIComponent(name.split('?')[0]),
        };
    } catch {
        return null;
    }
}

function buildWclCharacterUrl({ region, realm, name }) {
    if (!region || !realm || !name) return null;
    return `${WCL_ORIGIN}/character/${region.toLowerCase()}/${String(realm).replace(/\s/g, '-').toLowerCase()}/${name}`;
}

export {
    roleForSpec,
    thresholdsForRole,
    failsWclThresholds,
    buildScoutThresholds,
    scoutVerdict,
    characterFromWclUrl,
    buildWclCharacterUrl,
    WCL_ORIGIN,
};
