// common.js — injected before all site content scripts via manifest run_at: document_start

const WOW_CLASS_NAMES = [
    'warrior', 'paladin', 'hunter', 'rogue', 'priest',
    'shaman', 'mage', 'warlock', 'monk', 'druid',
    'deathknight', 'demon_hunter', 'evoker'
];

function normalizeClassName(name) {
    if (!name) return null;
    const lower = name.toLowerCase().replace(/ /g, '');
    if (lower === 'deathknight') return 'deathknight';
    if (lower === 'demonhunter') return 'demon_hunter';
    return lower.replace(/ /g, '_');
}

// ─── Spec → role ───────────────────────────────────────────────────────────────
// Sites publish the spec far more reliably than the role: Raider.IO dropped its
// role column entirely in favour of a spec icon on every row. Spec names are
// unambiguous across classes for role purposes — both Restoration specs heal,
// both Protection specs tank — so the spec alone settles the role.
//
// Third copy of this map, and deliberately so: src/preflight.js has one because
// the service worker cannot import a content script, and src/wcl-api.js resolves
// the ranked spec the same way. Content scripts are classic scripts with no
// export surface, so this cannot be shared either. Keep the three in step;
// tests/common.test.js pins this copy's behaviour.

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

function sendMessageToBackground(action, data = {}, callback) {
    if (typeof callback === 'function') {
        chrome.runtime.sendMessage({ action, ...data }, response => {
            // Swallow "receiving end does not exist" — the worker may be
            // restarting; callers treat a missing response as "unknown".
            callback(chrome.runtime.lastError ? null : response);
        });
        return;
    }
    chrome.runtime.sendMessage({ action, ...data });
}

// ─── Cloudflare interstitial ───────────────────────────────────────────────────
// Cloudflare serves its challenge at the requested page's own URL, so a content
// script matched on that URL runs against the interstitial rather than the site.
// Every check that follows then fails for a reason that has nothing to do with
// the site: selectors are missing, tables are empty, rows never render.
//
// Both WoWProgress and WarcraftLogs sit behind it, so this is shared rather than
// copied. Detection is by the markers Cloudflare's own challenge page carries;
// the title check catches the plain "Just a moment…" variant, which is what both
// sites actually serve.
function isCloudflareChallengePage() {
    if (document.getElementById('challenge-running') ||
        document.getElementById('cf-challenge-running') ||
        document.getElementById('challenge-error-title')) return true;
    if (document.querySelector('script[src*="challenge-platform"]')) return true;
    const title = (document.title || '').toLowerCase();
    return title.startsWith('just a moment') || title.includes('attention required');
}

// ─── Selector self-check ───────────────────────────────────────────────────────
// Call this on any critical selector so breakage is surfaced in the console
// rather than silently failing.

function assertSelector(selector, context = document, label = '') {
    const found = context.querySelector(selector);
    if (!found) {
        console.warn(`[RaidScout] Selector not found${label ? ' (' + label + ')' : ''}: ${selector} — site markup may have changed`);
    }
    return found;
}

// ─── Proactive WarcraftLogs scoring ───────────────────────────────────────────

// Ask the background for a character's parse scores.
// character: { region, realm, name, role? }  — role drives dps vs hps metric
// Resolves to { best, median, notFound?, error?, rateLimitMs? }. Never rejects.
function requestWclScore(character) {
    return new Promise(resolve => {
        chrome.runtime.sendMessage(
            { action: 'fetchWclScore', character },
            response => {
                if (chrome.runtime.lastError || !response) {
                    resolve({ best: null, median: null, error: 'NO_RESPONSE' });
                } else {
                    resolve(response);
                }
            }
        );
    });
}

// The API resolves a character's role from the spec WarcraftLogs ranked them
// as, which beats whatever the page markup suggested. Prefer it when present.
function effectiveRole(score, fallbackRole) {
    return (score && score.role) || fallbackRole || 'dps';
}

// Returns the right threshold pair for a given role.
// Tank falls back to the DPS threshold if no tank-specific one is set.
function thresholdsForRole(role, settings) {
    if (role === 'healer') {
        return {
            minBest:   settings.minBestHealer   || 0,
            minMedian: settings.minMedianHealer || 0,
        };
    }
    if (role === 'tank') {
        return {
            minBest:   settings.minBestTank   || settings.minBest   || 0,
            minMedian: settings.minMedianTank || settings.minMedian || 0,
        };
    }
    // dps / unknown
    return {
        minBest:   settings.minBest   || 0,
        minMedian: settings.minMedian || 0,
    };
}

// True when WarcraftLogs gave a definitive answer that this character has no
// logs, as opposed to a lookup that failed or never ran. See the note in
// failsWclThresholds for why that difference decides everything here.
function hasNoWclLogs(score) {
    if (!score || score.error) return false;
    return !!score.notFound || (score.best === null && score.median === null);
}

// Returns true if the element/row should be hidden.
//
// A character with no logs at all fails: they cannot be judged against a parse
// threshold, so showing them beside raiders who cleared it is noise. This is
// unconditional rather than a setting — it is what "above X parse" means.
//
// What never hides is a lookup that did not produce an answer: a transient
// error, a rate limit, a missing API key. Those describe the *request*, not the
// player, and hiding on them would empty an entire page on a misconfiguration.
// That fail-open rule is the one thing this function must never break.
//
// `role` is the character's role; `settings` contains per-role threshold keys.
function failsWclThresholds(score, settings, role) {
    const { minBest, minMedian } = thresholdsForRole(role || 'dps', settings);
    if (!score) return false;                               // never scored → keep
    if (score.error) return false;                          // transient failure → keep
    if (hasNoWclLogs(score)) return true;                   // no logs → below any threshold
    if (minBest   > 0 && score.best   !== null && score.best   < minBest)   return true;
    if (minMedian > 0 && score.median !== null && score.median < minMedian) return true;
    return false;
}

// Concurrency-limited promise pool.
// limit defaults to 4; pass the wclConcurrency storage value to override.
async function runWithConcurrency(items, worker, limit = 4) {
    const queue = [...items];
    const runners = [];
    for (let i = 0; i < Math.min(limit, queue.length); i++) {
        runners.push((async () => {
            while (queue.length) await worker(queue.shift());
        })());
    }
    await Promise.all(runners);
}

// Read the configured concurrency from storage (defaults to 4).
function getConcurrency(options) {
    const n = parseInt(options?.wclConcurrency);
    return (isNaN(n) || n < 1 || n > 8) ? 4 : n;
}

// ─── Shared proactive-scoring thresholds ───────────────────────────────────────
// Parse thresholds are configured ONCE in the WarcraftLogs section and drive
// proactive scoring on every site; each site only toggles the feature on/off.
// The DPS Best/Median values are the same `bestParseThreshold`/`parseThreshold`
// used by the WarcraftLogs tab auto-close, so there is a single source of truth.
const SHARED_WCL_KEYS = [
    'bestParseThreshold', 'parseThreshold',
    'wclMinBestHealer', 'wclMinMedianHealer',
    'wclMinBestTank', 'wclMinMedianTank',
    'wclConcurrency', 'wclSortByParse',
    // Not a threshold, but it changes every score, so a change must re-score.
    'wclDifficulty',
    // Read only for migration — see wclSortEnabled() below.
    'wpWclSort', 'rioWclSort', 'gowWclSort',
];

// Sorting by parse is one preference, not three. It used to be stored per site
// (wpWclSort / rioWclSort / gowWclSort), which meant setting the same thing in
// three places for an option nobody wants applied inconsistently.
//
// Existing installs keep working: if the shared key was never written, any of
// the three old keys being on turns sorting on. The options page writes the
// shared key on the next save, and the old ones stop mattering.
function wclSortEnabled(options) {
    if (typeof options.wclSortByParse === 'boolean') return options.wclSortByParse;
    return !!(options.wpWclSort || options.rioWclSort || options.gowWclSort);
}

// The DPS pair are the only thresholds with a non-zero default (60 best / 50
// median — what the popup and options page show on a fresh install). An absent
// key means "never saved", so it takes that default; a saved 0 means "no
// minimum" and must stay 0. `parseInt(x) || 0` got the first case wrong and
// scored fresh installs against no threshold at all while displaying 60/50.
const DEFAULT_BEST_PARSE   = 60;
const DEFAULT_MEDIAN_PARSE = 50;

function thresholdSetting(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    const n = parseInt(value);
    return Number.isNaN(n) ? fallback : n;
}

// Build the role-aware settings object consumed by thresholdsForRole /
// failsWclThresholds from a storage snapshot. The per-site enable flag is
// handled by each caller; this only carries the shared thresholds.
function buildWclSettings(options) {
    return {
        minBest:         thresholdSetting(options.bestParseThreshold, DEFAULT_BEST_PARSE),
        minMedian:       thresholdSetting(options.parseThreshold,     DEFAULT_MEDIAN_PARSE),
        minBestHealer:   parseInt(options.wclMinBestHealer)   || 0,
        minMedianHealer: parseInt(options.wclMinMedianHealer) || 0,
        minBestTank:     parseInt(options.wclMinBestTank)     || 0,
        minMedianTank:   parseInt(options.wclMinMedianTank)   || 0,
        concurrency:     getConcurrency(options),
    };
}

// ─── Inline parse badge ────────────────────────────────────────────────────────
// Rendered on each scored row/card so users see the number, not just a binary hide.
// State: 'pending' | 'no-logs' | 'error' | 'rate-limited' | { best, median }

const BADGE_CSS_ID = 'raidscout-badge-styles';

function ensureBadgeStyles() {
    if (document.getElementById(BADGE_CSS_ID)) return;
    const style = document.createElement('style');
    style.id = BADGE_CSS_ID;
    style.textContent = `
.rs-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    font-weight: 600;
    line-height: 1;
    padding: 2px 6px;
    border-radius: 3px;
    vertical-align: middle;
    margin-left: 6px;
    white-space: nowrap;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    cursor: default;
}
.rs-badge--pending  { background: #333; color: #888; }
.rs-badge--no-logs  { background: #3a3000; color: #c8a600; border: 1px solid #c8a600; }
.rs-badge--error    { background: #2a0000; color: #c04040; }
.rs-badge--limited  { background: #2a1a00; color: #c07820; }
.rs-badge--score    { background: #0d2d0d; color: #4caf50; border: 1px solid #2a6e2a; }
.rs-badge--score.rs-badge--warn { background: #2d1a00; color: #f09020; border-color: #7a4a00; }
.rs-badge--score.rs-badge--fail { background: #2d0000; color: #f04040; border-color: #7a0000; }
.rs-badge__icon { font-style: normal; }
.rs-filter-summary {
    font-size: 12px;
    color: #aaa;
    padding: 4px 0 8px;
    border-bottom: 1px solid #333;
    margin-bottom: 4px;
}
.rs-filter-summary strong { color: #e04040; }
`;
    (document.head || document.documentElement).appendChild(style);
}

function makeBadge(state, score, settings, role) {
    ensureBadgeStyles();
    const el = document.createElement('span');
    el.className = 'rs-badge';

    if (state === 'pending') {
        el.classList.add('rs-badge--pending');
        el.title = 'RaidScout: fetching WarcraftLogs score…';
        el.textContent = '⏳ WCL';
        return el;
    }
    if (state === 'no-logs') {
        el.classList.add('rs-badge--no-logs');
        el.title = `RaidScout: no ${difficultyLabel(score?.difficulty)}WarcraftLogs data for this character`;
        el.textContent = '📋 No logs';
        return el;
    }
    if (state === 'error') {
        el.classList.add('rs-badge--error');
        el.title = `RaidScout: lookup failed — ${score?.error || ''}`;
        el.textContent = '⚠ WCL err';
        return el;
    }
    if (state === 'rate-limited') {
        el.classList.add('rs-badge--limited');
        el.title = 'RaidScout: WarcraftLogs API rate limited — try again shortly';
        el.textContent = '🚦 Rate limited';
        return el;
    }
    if (state === 'blocked') {
        el.classList.add('rs-badge--limited');
        el.title = 'RaidScout: WarcraftLogs is challenging API requests (Cloudflare). '
                 + 'Open warcraftlogs.com in a tab and complete the check, then reload this page.';
        el.textContent = '☁ CF check';
        return el;
    }

    // Scored state — use role-aware thresholds for colour coding
    el.classList.add('rs-badge--score');
    const { best, median } = score;
    role = effectiveRole(score, role);
    const fails = settings ? failsWclThresholds(score, settings, role) : false;
    const { minBest, minMedian } = settings ? thresholdsForRole(role, settings) : {};
    const warnOnly = !fails && settings && (
        (minBest   > 0 && best   !== null && best   < (minBest   || 0) * 1.1) ||
        (minMedian > 0 && median !== null && median < (minMedian || 0) * 1.1)
    );

    if (fails)         el.classList.add('rs-badge--fail');
    else if (warnOnly) el.classList.add('rs-badge--warn');

    const metric = role === 'healer' ? 'HPS' : 'DPS';
    const fmt = v => v !== null ? Math.round(v) + '%' : '?';
    const tag = { 3: 'N ', 4: 'H ', 5: 'M ' }[score.difficulty] || '';
    el.textContent = `WCL ${tag}${fmt(best)} / ${fmt(median)}`;
    el.title = `RaidScout WarcraftLogs ${difficultyLabel(score.difficulty)}${metric}: Best ${fmt(best)}, Median ${fmt(median)}`;
    return el;
}

// A score carries the raid difficulty its numbers were read at — the pinned
// wclDifficulty, or whichever WarcraftLogs picked (the hardest one logged) — so
// the badge can say so: "Heroic " with its trailing space, or nothing when the
// difficulty is unknown.
function difficultyLabel(difficulty) {
    if (difficulty === 3) return 'Normal ';
    if (difficulty === 4) return 'Heroic ';
    if (difficulty === 5) return 'Mythic ';
    return '';
}

// Map a score result to its badge state. Every site scored rows the same way,
// with the Cloudflare case newly folded in here rather than four times over.
function badgeStateForScore(score) {
    if (!score) return 'error';
    if (score.error && score.cloudflareMs) return 'blocked';
    if (score.error && score.rateLimitMs)  return 'rate-limited';
    if (score.error)                       return 'error';
    if (score.notFound || (score.best === null && score.median === null)) return 'no-logs';
    return 'score';
}

function setBadgeState(container, state, score, settings, role) {
    let badge = container.querySelector('.rs-badge');
    if (badge) badge.remove();
    badge = makeBadge(state, score, settings, role);
    container.appendChild(badge);
    return badge;
}

// ─── Filter summary bar ────────────────────────────────────────────────────────
// Injected above the list to show "X of Y hidden by WCL parse filter"

function upsertFilterSummary(anchorEl, hidden, total) {
    ensureBadgeStyles();
    if (!anchorEl || !anchorEl.parentNode) return;
    let bar = anchorEl.parentNode.querySelector('.rs-filter-summary');
    if (!bar) {
        bar = document.createElement('div');
        bar.className = 'rs-filter-summary';
        anchorEl.parentNode.insertBefore(bar, anchorEl);
    }
    if (hidden === 0) {
        bar.textContent = `RaidScout: all ${total} candidates pass your WCL parse filter`;
        bar.querySelector('strong')?.remove();
    } else {
        bar.innerHTML = `RaidScout: <strong>${hidden} of ${total}</strong> hidden by WCL parse filter`;
    }
}

// ─── Live re-evaluation on settings change ────────────────────────────────────
// Call this with an array of the storage keys your site cares about.
// onSettingsChanged will be called whenever any of them change.

function watchSettings(keys, onSettingsChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync' && keys.some(k => k in changes)) {
            onSettingsChanged(changes);
        }
    });
}

// Clear all WCL scoring markers from a NodeList/Array of elements so they
// will be re-evaluated on the next scoring pass.
function clearWclMarkers(elements) {
    for (const el of elements) {
        delete el.dataset.wclScored;
        delete el.dataset.wclHidden;
        delete el.dataset.wclBest;
        delete el.dataset.wclMedian;
        delete el.dataset.wclDifficulty;
        const badge = el.querySelector('.rs-badge');
        if (badge) badge.remove();
    }
}

// ─── Sort by WCL parse ─────────────────────────────────────────────────────────
// Re-orders `items` (rows/cards) within their shared parent by score, highest
// first. Reads `dataset.wclMedian` (falling back to `dataset.wclBest`), set by
// each site's scoring pass. Items with no score sort last. No-op below 2 items
// or if the items aren't attached to a common parent.
//
// Grouped by raid difficulty first — every mythic parse, then every heroic one
// — because the two are not on one scale: mythic fields are stronger, so a
// mythic 60% can be the better player than a heroic 80%. Mirrors parseSortValue()
// in scout-core.js; tests/common.test.js pins the two against each other.
function wclSortValue(difficulty, best, median) {
    const value = median ?? best ?? null;
    if (value === null || value === undefined || Number.isNaN(value)) return null;
    return (Number(difficulty) || 0) * 1000 + value;
}

function sortByWclScore(items) {
    if (!items || items.length < 2) return;
    const parent = items[0].parentNode;
    if (!parent) return;
    const num = v => { const n = parseFloat(v); return Number.isNaN(n) ? null : n; };
    const scored = items.map(el => ({
        el,
        value: wclSortValue(el.dataset.wclDifficulty,
                            num(el.dataset.wclBest), num(el.dataset.wclMedian)) ?? -1,
    }));
    scored.sort((a, b) => b.value - a.value);
    for (const { el } of scored) parent.appendChild(el);
}

// ─── Listing date ──────────────────────────────────────────────────────────────
// Scout can sort by when a character posted (or last bumped) their
// looking-for-guild listing. Each harvester hands back whatever raw date it can
// find and scout-core.js parseListedDate() interprets it, so the reading here is
// deliberately narrow: only markup that is unambiguously a timestamp, never a
// guess over arbitrary text — a guild called "Remnant 2020" must not read as a
// listing date. Returns a raw value (timestamp or text) or null.
//
//   root     — the row/card/cell to search
//   cellText — true when `root` IS the date cell (Raider.IO's "Published"
//              column), so its own text may be used as a last resort
const RELATIVE_DATE_TEXT = /^(?:about |over |almost )?(?:\d+|an?|one)\s*[a-z]+\s+ago$|^(?:today|yesterday|just now)$/i;

function readListedDate(root, { cellText = false } = {}) {
    if (!root) return null;
    const time = root.matches?.('time[datetime]') ? root : root.querySelector('time[datetime]');
    if (time) return time.getAttribute('datetime');
    const ts = root.matches?.('[data-ts]') ? root : root.querySelector('[data-ts]');
    if (ts) return ts.getAttribute('data-ts');

    if (cellText) {
        const titled = root.matches?.('[title]') ? root : root.querySelector('[title]');
        const text = root.textContent?.trim();
        return text || titled?.getAttribute('title') || null;
    }

    // Otherwise only a leaf whose whole text reads as a relative date.
    for (const el of root.querySelectorAll('span, small, div, p, time')) {
        if (el.children.length) continue;
        const text = el.textContent.trim();
        if (RELATIVE_DATE_TEXT.test(text)) return text;
    }
    return null;
}

// ─── Listing age filter ────────────────────────────────────────────────────────
// Each site can hide listings older than N days (wpMaxListedDays,
// rioMaxListedDays, gowMaxListedDays). Interpreting the raw date is
// scout-core.js parseListedDate()'s job, but content scripts cannot import an ES
// module, so this is a copy — tests/common.test.js runs both over the same inputs
// and asserts they agree. If they ever disagree, scout-core.js is the reference.

const LISTED_UNITS_MS = {
    second: 1000, minute: 60 * 1000, hour: 60 * 60 * 1000, day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000, month: 30 * 24 * 60 * 60 * 1000, year: 365 * 24 * 60 * 60 * 1000,
};
const LISTED_UNIT_ALIASES = {
    sec: 'second', secs: 'second', s: 'second',
    min: 'minute', mins: 'minute', m: 'minute',
    hr: 'hour', hrs: 'hour', h: 'hour',
    d: 'day', w: 'week', wk: 'week', wks: 'week',
    mo: 'month', mos: 'month', y: 'year', yr: 'year', yrs: 'year',
};
const EARLIEST_LISTING_MS = Date.UTC(2004, 0, 1);

function parseListedDate(value, now = Date.now()) {
    if (value === null || value === undefined || value === '') return null;

    if (typeof value === 'number' || /^\s*\d{9,13}\s*$/.test(String(value))) {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) return null;
        const ms = n < 1e12 ? n * 1000 : n;
        return ms >= EARLIEST_LISTING_MS && ms <= now + LISTED_UNITS_MS.day ? ms : null;
    }

    const text = String(value).trim().toLowerCase();
    if (!text) return null;

    if (/^(just now|now|moments? ago|a few seconds ago)$/.test(text)) return now;
    if (text === 'today')     return now;
    if (text === 'yesterday') return now - LISTED_UNITS_MS.day;

    // "ago" is optional: Raider.IO's Published column prints a bare "3d" / "2w".
    const rel = text.match(/^(?:about\s+|over\s+|almost\s+)?(?:(\d+)\s*|(an?|one)\s+)([a-z]+?)s?(?:\s+ago)?$/);
    if (rel) {
        const count = rel[1] !== undefined ? parseInt(rel[1], 10) : 1;
        const unit  = LISTED_UNITS_MS[rel[3]] ? rel[3] : LISTED_UNIT_ALIASES[rel[3]];
        return unit ? now - count * LISTED_UNITS_MS[unit] : null;
    }

    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed >= EARLIEST_LISTING_MS && parsed <= now + LISTED_UNITS_MS.day) {
        return parsed;
    }
    return null;
}

// Mirrors scout-core.js isListedWithin(). An unreadable date is kept: the date
// markup on WoWProgress and Guilds of WoW was never verified against live pages
// (quirk 59), and hiding every row whose date could not be read would empty the
// page the day a selector drifts.
function isListedWithin(listedAt, maxDays, now = Date.now()) {
    if (!(maxDays > 0)) return true;
    if (listedAt === null || listedAt === undefined) return true;
    return now - listedAt <= maxDays * LISTED_UNITS_MS.day;
}

// Storage → a day count. Anything absent, blank or nonsensical is 0 ("any age").
function maxListedDaysSetting(value) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

// ─── Scout harvest hook ────────────────────────────────────────────────────────
// The Scout page (src/scout/) aggregates candidates from every configured site
// without the user browsing to each one. For sites whose listings are rendered
// client-side (Raider.IO, Guilds of WoW, WCL recruitment), the Scout page opens
// the listing in a background tab, lets THIS content script render and filter it
// exactly as it would for a human, then asks for the visible rows back.
//
// Each site calls registerHarvester() once with:
//   sourceId      — must match the adapter id in src/scout/sources.js
//   readySelector — selector that only matches once the listing has rendered
//   collect       — () => array of raw candidate objects (visible rows only)
//
// Reporting an empty harvest as ok:false is deliberate. Every other filtering
// path in this extension fails OPEN (never hide on error); an aggregator must
// fail VISIBLE instead, or a site whose markup changed silently shortens the
// officer's list and they trust a result that is wrong.

function registerHarvester(sourceId, readySelector, collect) {
    chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
        if (message?.action !== 'harvestCandidates' || message.source !== sourceId) return;

        const deadline = Date.now() + (message.timeoutMs || 15000);
        const settleMs = message.settleMs ?? 700;

        (function attempt() {
            if (document.querySelector(readySelector)) {
                // Let the site's own filter pass finish before reading rows,
                // otherwise we harvest candidates this extension is about to hide.
                setTimeout(function () {
                    try {
                        sendResponse({
                            ok: true,
                            source: sourceId,
                            url: location.href,
                            candidates: collect() || [],
                            // Rows on the page before any filter hid them. Scout's
                            // "Load more" needs it to tell a page the filters
                            // emptied (keep paging) from the end of the listing.
                            rowsSeen: document.querySelectorAll(readySelector).length,
                        });
                    } catch (err) {
                        sendResponse({
                            ok: false, source: sourceId, url: location.href,
                            error: `Extraction failed: ${err?.message || err}`, candidates: [],
                        });
                    }
                }, settleMs);
                return;
            }
            if (Date.now() > deadline) {
                sendResponse({
                    ok: false, source: sourceId, url: location.href, candidates: [],
                    error: `No results rendered within ${Math.round((message.timeoutMs || 15000) / 1000)}s ` +
                           `(selector "${readySelector}"). The page may require sign-in, or its markup changed.`,
                });
                return;
            }
            setTimeout(attempt, 300);
        })();

        return true; // async response
    });
}
