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

// Spec name → role. Some sites (Raider.IO) publish only the spec, never the
// role, so the role a metric depends on has to be derived from it. Spec names
// are unique enough across classes that no class context is needed: every
// "Restoration"/"Holy" is a healer, every "Protection" a tank, every "Frost"
// a DPS.
//
// Every current spec is listed, not just the tanks and healers, because two
// different questions get asked of this table:
//
//   specToRole()      — "what role is this spec?" Unknown means a spec name we
//                       have not seen, and DPS is the right guess.
//   roleFromSpecName() — "is this string a spec at all?" Used when scanning
//                       arbitrary page text for a role, where guessing DPS on
//                       every non-spec word would make the scan useless.
const SPEC_ROLE = {
    // Tanks
    blood: 'tank', vengeance: 'tank', guardian: 'tank', brewmaster: 'tank',
    protection: 'tank',
    // Healers
    restoration: 'healer', preservation: 'healer', mistweaver: 'healer',
    holy: 'healer', discipline: 'healer',
    // DPS
    frost: 'dps', unholy: 'dps', havoc: 'dps', balance: 'dps', feral: 'dps',
    devastation: 'dps', augmentation: 'dps', marksmanship: 'dps', survival: 'dps',
    arcane: 'dps', fire: 'dps', windwalker: 'dps', retribution: 'dps',
    shadow: 'dps', assassination: 'dps', outlaw: 'dps', subtlety: 'dps',
    elemental: 'dps', enhancement: 'dps', affliction: 'dps', demonology: 'dps',
    destruction: 'dps', arms: 'dps', fury: 'dps',
    // Two words on every site that publishes it.
    'beast mastery': 'dps',
};

// Unknown spec → 'dps'. Correct where the caller already knows the string IS a
// spec (Raider.IO's API hands us `spec.name`), so an unrecognised one is far
// more likely a new DPS spec than a new tank or healer.
function specToRole(spec) {
    if (!spec) return null;
    return SPEC_ROLE[spec.trim().toLowerCase()] ?? 'dps';
}

// Unknown spec → null. For scanning page text, where "is this a spec?" has to
// be answerable with "no".
function roleFromSpecName(spec) {
    if (!spec) return null;
    return SPEC_ROLE[spec.trim().toLowerCase()] ?? null;
}

// Scan a string for a SPEC name and return its role, or null. Splits on
// non-letters, so it reads a spec out of prose, an icon's alt text, or a CSS
// class alike ("spec-mistweaver", "beast-mastery-icon").
//
// Deliberately excludes the explicit role words that roleFromText matches: this
// is used to sift CSS class names, where a stray "damage-meter" or "ranged-col"
// would otherwise be read as a role the page never claimed.
function roleFromSpecText(text) {
    if (!text) return null;
    const lower = String(text).toLowerCase();

    // "Beast Mastery" is the only two-word spec, so it cannot survive the split.
    if (/beast[^a-z]+mastery/.test(lower)) return 'dps';

    for (const word of lower.split(/[^a-z]+/)) {
        const role = roleFromSpecName(word);
        if (role) return role;
    }
    return null;
}

// Pull a role out of arbitrary page text: an explicit role word if the site
// prints one, otherwise a spec name appearing anywhere in it. Returns null when
// neither is present, so callers can tell "unknown" from "DPS".
function roleFromText(text) {
    if (!text) return null;
    const lower = String(text).toLowerCase();

    // Explicit role wording wins — it is the site stating the answer.
    if (/\b(healer|healers|healing|heals)\b/.test(lower)) return 'healer';
    if (/\b(tank|tanks|tanking)\b/.test(lower))           return 'tank';
    if (/\b(dps|damage|ranged|melee)\b/.test(lower))      return 'dps';

    return roleFromSpecText(lower);
}

function sendMessageToBackground(action, data = {}) {
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

    // Scored state — use role-aware thresholds for colour coding
    el.classList.add('rs-badge--score');
    const { best, median } = score;
    const fails = settings ? failsWclThresholds(score, settings, role) : false;
    const { minBest, minMedian } = settings ? thresholdsForRole(role || 'dps', settings) : {};
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

// Every site Scout harvests is behind bot protection: WoWProgress, GoW and
// WarcraftLogs sit behind Cloudflare, and WarcraftLogs additionally gates
// listing pages behind its own one-click /human-challenge form. A tab that lands
// on one of those never renders the listing, so without this the harvest just
// times out and blames the selector or the officer's filters.
//
// The two kinds are NOT interchangeable, and treating them alike is a bug:
//
//   'waiting'     — Cloudflare's JS check ("Just a moment…"). It solves itself
//                   in a few seconds and then loads the real page, so the only
//                   correct response is to keep waiting. Failing fast here is
//                   what made WoWProgress report a Cloudflare check it would
//                   have cleared on its own.
//   'interactive' — needs a human to click something (WarcraftLogs' one-click
//                   form). No amount of waiting helps, so stop immediately and
//                   say what to do.
//
// Returns { kind, label } or null on a real page.
function detectInterstitial() {
    const title = (document.title || '').trim();

    // WarcraftLogs' gate: its own page, with a real form to submit.
    if (/human-challenge/i.test(location.pathname) || /^human verification$/i.test(title))
        return { kind: 'interactive', label: 'a one-click human-verification page' };

    // Cloudflare's own pages all title themselves "Just a moment...". A managed
    // challenge and a plain JS check look alike from the DOM, so both are
    // treated as 'waiting'; a managed one simply never clears and is reported at
    // the deadline instead.
    if (/^just a moment/i.test(title) ||
        document.querySelector('#challenge-running, #cf-challenge-running, #challenge-stage'))
        return { kind: 'waiting', label: 'a Cloudflare check' };

    return null;
}

// When a ready selector never matches, "the markup changed" is true but useless
// on its own. A site's listing rows are by definition a class that repeats many
// times, so reporting the most-repeated class names turns the next failure
// report into the answer instead of another round trip.
function countClassNames(elements, depth = 0) {
    const counts = new Map();
    for (const start of elements) {
        let el = start;
        for (let up = 0; el && up <= depth; up++, el = el.parentElement) {
            if (typeof el.className !== 'string') continue;   // SVG animated class
            for (const name of el.className.trim().split(/\s+/)) {
                if (name.length > 2) counts.set(name, (counts.get(name) || 0) + 1);
            }
        }
    }
    return counts;
}

function topClasses(counts, { min = 5, limit = 8 } = {}) {
    return [...counts]
        .filter(([, n]) => n >= min)      // a one-off wrapper is never the row
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([name, n]) => `.${name} (${n})`);
}

// tag.class.class for one element, so a chain reads like a CSS path.
function describeElement(el) {
    const classes = typeof el.className === 'string'
        ? el.className.trim().split(/\s+/).filter(Boolean)
        : [];
    return el.tagName.toLowerCase() + classes.map(c => `.${c}`).join('');
}

function ancestorChain(start, depth = 10) {
    const chain = [];
    let el = start;
    for (let up = 0; el && up < depth && el !== document.body; up++, el = el.parentElement) {
        chain.push(describeElement(el));
    }
    return chain.join(' < ');
}

// Names the element that most likely IS the listing row, for when a ready
// selector never matches.
//
// Counting every repeated class on the page was the first attempt and only
// narrowed it down — it surfaced the page's chrome (footers, nav, icons)
// alongside the rows. A listing row almost always *links to the thing it lists*,
// so walking up from each character link and counting the classes on the way
// points at the container directly. Falls back to the page-wide count, and to
// reporting the links themselves, when there is nothing to walk up from.
function describeRowCandidates() {
    const links = Array.from(document.querySelectorAll(
        'a[href*="/character/"], a[href*="/characters/"]'));

    if (links.length >= 3) {
        // The counted list says which classes are involved; the chain says how
        // they nest, which is what actually identifies the row. Counts alone
        // cannot: every ancestor of a link is seen once per link, so a row
        // container and a page-level wrapper score identically.
        const wrappers = topClasses(countClassNames(links, 10), { min: 2, limit: 10 });
        return `${links.length} character links found. Ancestors of the first, ` +
               `innermost first: ${ancestorChain(links[0])}. ` +
               `Commonest wrapping classes: ${wrappers.join(', ') || 'none'}`;
    }

    const repeated = topClasses(countClassNames(document.querySelectorAll('[class]')));
    const hrefs = [...new Set(Array.from(document.querySelectorAll('a[href]'))
        .map(a => a.getAttribute('href'))
        .filter(h => h && !h.startsWith('#') && h.length < 60))].slice(0, 6);

    return `no character links on the page. Repeated classes: ` +
           `${repeated.join(', ') || 'none'}. Sample links: ${hrefs.join(' ') || 'none'}`;
}

function registerHarvester(sourceId, readySelector, collect) {
    chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
        if (message?.action !== 'harvestCandidates' || message.source !== sourceId) return;

        const deadline = Date.now() + (message.timeoutMs || 15000);
        const settleMs = message.settleMs ?? 700;

        function failGate(gate) {
            sendResponse({
                ok: false, source: sourceId, url: location.href, candidates: [],
                interstitial: true,
                error: `the site is showing ${gate.label} instead of the listing. Open it in a ` +
                       `normal tab, clear the check, then run Scout again.`,
            });
        }

        (function attempt() {
            // An interactive gate is the answer, so report it immediately rather
            // than waiting out the full timeout to blame the selector. A
            // self-solving one is NOT an answer — keep polling and let the
            // deadline branch below report it only if it never clears.
            const gate = detectInterstitial();
            if (gate && gate.kind === 'interactive') { failGate(gate); return; }

            if (!gate && document.querySelector(readySelector)) {
                // Let the site's own filter pass finish before reading rows,
                // otherwise we harvest candidates this extension is about to hide.
                setTimeout(function () {
                    try {
                        sendResponse({
                            ok: true,
                            source: sourceId,
                            url: location.href,
                            candidates: collect() || [],
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
                // A check still up at the deadline is the real reason nothing
                // rendered, so report that rather than the selector.
                if (gate) { failGate(gate); return; }
                sendResponse({
                    ok: false, source: sourceId, url: location.href, candidates: [],
                    error: `No results rendered within ${Math.round((message.timeoutMs || 15000) / 1000)}s ` +
                           `(selector "${readySelector}"). The page may require sign-in, or its markup ` +
                           `changed. Repeated class names on the page: ${describeRowCandidates()}`,
                });
                return;
            }
            setTimeout(attempt, 300);
        })();

        return true; // async response
    });
}
