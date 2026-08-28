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
            minBest:     settings.minBestHealer  || 0,
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
    // dps / unknown
    return {
        minBest:     settings.minBest   || 0,
        minMedian:   settings.minMedian || 0,
        hideUnknown: settings.hideUnknown,
    };
}

// Returns true if the element/row should be hidden.
// Never hides on transient errors (fail-open).
// `role` is the character's role; `settings` contains per-role threshold keys.
function failsWclThresholds(score, settings, role) {
    const { minBest, minMedian, hideUnknown } = thresholdsForRole(role || 'dps', settings);
    if (!score) return !!hideUnknown;
    if (score.error) return false;                          // transient failure → keep
    const haveData = score.best !== null || score.median !== null;
    if (!haveData) return !!hideUnknown;                    // never logged → user's choice
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
    'wclHideUnknown', 'wclConcurrency',
];

// Build the role-aware settings object consumed by thresholdsForRole /
// failsWclThresholds from a storage snapshot. The per-site enable flag is
// handled by each caller; this only carries the shared thresholds.
function buildWclSettings(options) {
    return {
        minBest:         parseInt(options.bestParseThreshold) || 0,
        minMedian:       parseInt(options.parseThreshold)     || 0,
        minBestHealer:   parseInt(options.wclMinBestHealer)   || 0,
        minMedianHealer: parseInt(options.wclMinMedianHealer) || 0,
        minBestTank:     parseInt(options.wclMinBestTank)     || 0,
        minMedianTank:   parseInt(options.wclMinMedianTank)   || 0,
        hideUnknown:     !!options.wclHideUnknown,
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
        el.title = 'RaidScout: no WarcraftLogs data for this character';
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
    el.textContent = `WCL ${fmt(best)} / ${fmt(median)}`;
    el.title = `RaidScout WarcraftLogs ${metric}: Best ${fmt(best)}, Median ${fmt(median)}`;
    return el;
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
        const badge = el.querySelector('.rs-badge');
        if (badge) badge.remove();
    }
}

// ─── Sort by WCL parse ─────────────────────────────────────────────────────────
// Re-orders `items` (rows/cards) within their shared parent by score, highest
// first. Reads `dataset.wclMedian` (falling back to `dataset.wclBest`), set by
// each site's scoring pass. Items with no score sort last. No-op below 2 items
// or if the items aren't attached to a common parent.
function sortByWclScore(items) {
    if (!items || items.length < 2) return;
    const parent = items[0].parentNode;
    if (!parent) return;
    const scored = items.map(el => {
        const median = parseFloat(el.dataset.wclMedian);
        const best   = parseFloat(el.dataset.wclBest);
        const value  = !isNaN(median) ? median : (!isNaN(best) ? best : -1);
        return { el, value };
    });
    scored.sort((a, b) => b.value - a.value);
    for (const { el } of scored) parent.appendChild(el);
}
