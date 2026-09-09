// scout.js — orchestrator + UI for the Scout aggregator page.
//
// One click harvests every configured recruitment site, merges the results into
// one de-duplicated list of players, scores each unique player once through the
// existing WarcraftLogs pipeline, and renders the lot as a sortable table.
//
// Scoring, thresholds and badges are NOT reimplemented here: common.js is loaded
// ahead of this module by scout.html and supplies requestWclScore(),
// buildWclSettings(), failsWclThresholds(), makeBadge() and SHARED_WCL_KEYS as
// globals, so a candidate found by Scout is judged by exactly the same rules as
// one seen inline on the site itself.

import {
    SOURCE_META, SOURCE_IDS, normalizeCandidate, mergeCandidates, hasNoLogs, classLabel,
    sortCandidates, matchesQuery, profileLinks, toCsv, toWhisperList, runWithConcurrency, classIconUrl,
    formatMythicProgress,
    matchesFilters, normalizeFilters, activeFilterCount, DEFAULT_FILTERS, summarizeScoreErrors,
} from './scout-core.js';
import { adapterFor, DEFAULT_SOURCE_URLS, SITE_ENABLED_KEYS } from './sources.js';
import { fetchProfileFields, applyEnrichment, ENRICH_ORIGIN } from './enrich.js';

// ─── Defaults ──────────────────────────────────────────────────────────────────

const SCOUT_DEFAULTS = {
    scoutSources:             [...SOURCE_IDS],
    scoutMaxCandidates:       150,
    scoutPagesPerSource:      1,
    scoutWclEnabled:          true,
    scoutHideBelowThresholds: true,
    scoutEnrichRaiderio:      true,
    scoutFilters:             DEFAULT_FILTERS,
    scoutSortKey:             'wclMedian',
    scoutSortDir:             'desc',
};

// Regions the four sites actually publish. Kept here rather than derived from
// the harvest so the chips do not appear and vanish between runs.
const FILTER_REGIONS = ['eu', 'us', 'oc', 'kr', 'tw'];

const ROLE_LABELS = { tank: 'Tank', healer: 'Healer', dps: 'DPS' };

const SOURCE_URL_KEYS = {
    wowprogress:  'scoutUrlWowprogress',
    raiderio:     'scoutUrlRaiderio',
    guildsofwow:  'scoutUrlGuildsofwow',
};

// Two at a time: the tab-mode adapters each open a background tab, and three or
// four simultaneous SPA loads starve each other of CPU on modest machines,
// which shows up as spurious "nothing rendered" timeouts.
const HARVEST_CONCURRENCY = 2;

// ─── State ─────────────────────────────────────────────────────────────────────

const state = {
    settings:   {},
    wclSettings: null,
    candidates: [],
    sortKey:    'wclMedian',
    sortDir:    'desc',
    query:      '',
    filters:    { ...DEFAULT_FILTERS },
    running:    false,
    rowIndex:   new Map(),
    notices:    [],
};

// ─── Elements ──────────────────────────────────────────────────────────────────

const el = {
    run:          document.getElementById('runScout'),
    openSettings: document.getElementById('openSettings'),
    chips:        document.getElementById('sourceChips'),
    progress:     document.getElementById('progressLine'),
    banner:       document.getElementById('scoutBanner'),
    toggleNotices: document.getElementById('toggleNotices'),
    noticeCount:  document.getElementById('noticeCount'),
    noticeIcon:   document.getElementById('noticeIcon'),
    toolbar:      document.getElementById('scoutToolbar'),
    search:       document.getElementById('searchBox'),
    hideBelow:    document.getElementById('hideBelowThresholds'),
    count:        document.getElementById('resultCount'),
    copyNames:    document.getElementById('copyNames'),
    exportCsv:    document.getElementById('exportCsv'),
    table:        document.getElementById('resultsTable'),
    tbody:        document.getElementById('resultsBody'),
    empty:        document.getElementById('emptyState'),
    filters:      document.getElementById('scoutFilters'),
    toggleFilters: document.getElementById('toggleFilters'),
    filterCount:  document.getElementById('filterCount'),
    clearFilters: document.getElementById('clearFilters'),
    filterSummary: document.getElementById('filterSummary'),
    filterRoles:   document.getElementById('filterRoles'),
    filterRegions: document.getElementById('filterRegions'),
    filterClasses: document.getElementById('filterClasses'),
    filterSources: document.getElementById('filterSources'),
    filterMultiSource: document.getElementById('filterMultiSource'),
    minIlvl:      document.getElementById('filterMinIlvl'),
    minMplus:     document.getElementById('filterMinMplus'),
    minMythic:    document.getElementById('filterMinMythic'),
};

// ─── Settings ──────────────────────────────────────────────────────────────────

function loadSettings() {
    return new Promise(resolve => {
        chrome.storage.sync.get(null, data => resolve({ ...SCOUT_DEFAULTS, ...data }));
    });
}

function sourceUrl(sourceId, settings) {
    const custom = settings[SOURCE_URL_KEYS[sourceId]];
    return (typeof custom === 'string' && custom.trim()) ? custom.trim() : DEFAULT_SOURCE_URLS[sourceId];
}

function sendToBackground(message) {
    return new Promise(resolve => {
        chrome.runtime.sendMessage(message, response =>
            resolve(chrome.runtime.lastError ? null : response));
    });
}

// ─── Source chips ──────────────────────────────────────────────────────────────

function renderChips(sourceIds, allIds) {
    el.chips.innerHTML = '';
    for (const id of allIds) {
        const meta = SOURCE_META[id];
        const chip = document.createElement('span');
        chip.className = 'source-chip';
        chip.id = `chip-${id}`;
        chip.style.setProperty('--source-colour', meta.colour);
        chip.innerHTML = `<span class="chip-label"></span> <span class="chip-state"></span>`;
        chip.querySelector('.chip-label').textContent = meta.label;
        chip.querySelector('.chip-state').textContent = sourceIds.includes(id) ? 'queued' : 'off';
        if (!sourceIds.includes(id)) chip.classList.add('is-skipped');
        el.chips.appendChild(chip);
    }
}

function setChip(sourceId, stateName, text) {
    const chip = document.getElementById(`chip-${sourceId}`);
    if (!chip) return;
    chip.classList.remove('is-running', 'is-done', 'is-empty', 'is-failed');
    if (stateName) chip.classList.add(stateName);
    chip.querySelector('.chip-state').textContent = text;
}

function setProgress(text) { el.progress.textContent = text; }

// ─── Notices ───────────────────────────────────────────────────────────────────
// Notices live behind a counted button in the header rather than in a banner
// above the table. A run with four things to say — a Cloudflare fallback, a
// source that matched nobody, a candidate cap — used to push the results off the
// screen, and the one notice that actually mattered was styled identically to
// three routine ones.
//
// Two levels, because they are not the same kind of news: a 'warn' is something
// that happened and is worth knowing, an 'error' is a part of the run that did
// not work. The count covers both; the button turns red and the icon changes if
// any error is present, so severity is visible without opening the panel.

function noticesOpen() {
    return !el.banner.hidden;
}

function setNoticesOpen(open) {
    el.banner.hidden = !open;
    el.toggleNotices.setAttribute('aria-expanded', String(open));
}

function renderNotices() {
    const count  = state.notices.length;
    const errors = state.notices.filter(n => n.level === 'error').length;

    // No control at all on an uneventful run — a permanently greyed-out button
    // is just furniture.
    el.toggleNotices.hidden = count === 0;
    if (count === 0) { setNoticesOpen(false); el.banner.innerHTML = ''; return; }

    el.toggleNotices.classList.toggle('has-errors', errors > 0);
    el.noticeIcon.textContent  = errors > 0 ? '⚠' : 'ℹ';
    el.noticeCount.textContent = String(count);
    el.toggleNotices.title = errors > 0
        ? `${errors} of ${count} ${count === 1 ? 'notice' : 'notices'} ${errors === 1 ? 'is' : 'are'} a failure — click to read`
        : `${count} ${count === 1 ? 'notice' : 'notices'} — click to read`;

    el.banner.innerHTML = '';
    const list = document.createElement('ul');
    for (const notice of state.notices) {
        const li = document.createElement('li');
        li.className = `notice notice--${notice.level}`;
        li.innerHTML = notice.message;
        list.appendChild(li);
    }
    el.banner.appendChild(list);
}

function addNotice(message, level) {
    // De-duplicated on the rendered text: several sources failing the same way
    // produce the same sentence, and repeating it is not more informative.
    if (state.notices.some(n => n.message === message)) return;
    state.notices.push({ message, level });
    renderNotices();
}

function warn(message) { addNotice(message, 'warn'); }
function fail(message) { addNotice(message, 'error'); }

// ─── Harvest ───────────────────────────────────────────────────────────────────

async function harvestSource(sourceId, settings) {
    const adapter = adapterFor(sourceId);
    if (!adapter) return { ok: false, source: sourceId, candidates: [], error: 'No adapter registered' };

    const url = sourceUrl(sourceId, settings);
    setChip(sourceId, 'is-running', adapter.mode === 'tab' ? 'opening…' : 'fetching…');

    try {
        const result = await adapter.run(url, {
            settings,
            pagesPerSource: Math.max(1, parseInt(settings.scoutPagesPerSource) || 1),
        });
        return { ...result, source: sourceId, url };
    } catch (err) {
        return { ok: false, source: sourceId, url, candidates: [], error: err?.message || String(err) };
    }
}

async function runScout() {
    if (state.running) return;
    state.running = true;
    state.candidates = [];
    state.notices = [];
    state.rowIndex.clear();
    el.run.disabled = true;
    el.run.textContent = '⏳ Scouting…';
    renderNotices();
    el.table.hidden = true;
    el.toolbar.hidden = true;
    el.empty.hidden = true;

    const settings = await loadSettings();
    state.settings = settings;
    state.wclSettings = buildWclSettings(settings);
    el.hideBelow.checked = settings.scoutHideBelowThresholds !== false;
    restoreFilters(settings);

    const requested = Array.isArray(settings.scoutSources) ? settings.scoutSources : SCOUT_DEFAULTS.scoutSources;
    const sourceIds = SOURCE_IDS.filter(id => requested.includes(id));
    renderChips(sourceIds, SOURCE_IDS);

    if (sourceIds.length === 0) {
        finishRun('No sources selected. Turn some on in Settings → Scout.');
        return;
    }

    // A site whose integration toggle is off still harvests, but its content
    // script never filtered the page — say so rather than quietly returning a
    // list that ignores the officer's per-site criteria. Only 'tab' sources are
    // affected: the fetch adapter filters in-process (passesWowProgressFilters)
    // and does not care whether the site integration is switched on.
    for (const id of sourceIds) {
        if (adapterFor(id)?.mode === 'tab' && settings[SITE_ENABLED_KEYS[id]] === false) {
            warn(`<strong>${SOURCE_META[id].label}</strong> is switched off in settings, so its own ` +
                 `filters (item level, class, role…) were not applied to its results.`);
        }
    }

    setProgress('Harvesting…');
    const raw = [];
    let rowTotal = 0;
    // Sources that rendered but matched nobody. Collected rather than warned
    // about one at a time: the sentence is identical for each, and three
    // repetitions of it buried the warnings that actually differ.
    const cameBackEmpty = [];

    await runWithConcurrency(sourceIds, async (sourceId) => {
        const result = await harvestSource(sourceId, settings);

        if (!result.ok) {
            setChip(sourceId, 'is-failed', 'failed');
            fail(`<strong>${SOURCE_META[sourceId].label}</strong> returned nothing: ${escapeHtml(result.error || 'unknown error')} ` +
                 `<br><code>${escapeHtml(result.url || '')}</code>`);
            return;
        }

        const normalized = (result.candidates || [])
            .map(row => normalizeCandidate(row, sourceId))
            .filter(Boolean);

        const dropped = (result.candidates || []).length - normalized.length;
        rowTotal += normalized.length;
        raw.push(...normalized);

        // A source that matched nobody is not the same result as one that
        // found candidates, so it does not get the green "done" treatment.
        setChip(sourceId, normalized.length ? 'is-done' : 'is-empty', `${normalized.length}`);
        for (const w of result.warnings || []) warn(`<strong>${SOURCE_META[sourceId].label}</strong>: ${escapeHtml(w)}`);
        if (dropped > 0) {
            warn(`<strong>${SOURCE_META[sourceId].label}</strong>: ${dropped} row(s) skipped — no readable ` +
                 `character name/realm/region, so they could not be scored.`);
        }
        if (normalized.length === 0) cameBackEmpty.push(SOURCE_META[sourceId].label);
    }, HARVEST_CONCURRENCY);

    if (cameBackEmpty.length) {
        const names = cameBackEmpty.map(label => `<strong>${label}</strong>`);
        const list  = names.length === 1
            ? names[0]
            : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
        warn(`${list} rendered but produced no candidates. ` +
             `${names.length === 1 ? 'Its filters may be' : 'Their filters may be'} excluding everyone, ` +
             `or the listing ${names.length === 1 ? 'URL is' : 'URLs are'} wrong.`);
    }

    let merged = mergeCandidates(raw);
    const uniqueCount = merged.length;
    const duplicates = rowTotal - uniqueCount;

    const cap = Math.max(1, parseInt(settings.scoutMaxCandidates) || SCOUT_DEFAULTS.scoutMaxCandidates);
    if (merged.length > cap) {
        warn(`Found ${merged.length} candidates but the cap is ${cap} — showing the first ${cap}. ` +
             `Raise “Max candidates per run” in Settings → Scout, or tighten your per-site filters. ` +
             `The cap exists because every extra candidate is a WarcraftLogs API call.`);
        merged = merged.slice(0, cap);
    }

    state.candidates = merged;
    setProgress(`${uniqueCount} unique candidate${uniqueCount === 1 ? '' : 's'} from ${rowTotal} listing rows` +
                (duplicates > 0 ? ` — ${duplicates} cross-posted on more than one site` : ''));

    if (merged.length === 0) {
        finishRun('No candidates found.');
        return;
    }

    render();
    el.toolbar.hidden = false;
    el.table.hidden = false;

    // Score before cross-referencing, deliberately. The parse thresholds are what
    // actually decide who an officer looks at, and WarcraftLogs answers fastest —
    // it is an official API with a token, per-character caching and a
    // concurrency limit tuned to it. Hydrating first meant every candidate the
    // thresholds were about to discard was looked up on Raider.IO anyway, so the
    // slower of the two passes ran over the larger of the two sets.
    if (settings.scoutWclEnabled !== false) await scoreCandidates(merged);
    if (settings.scoutEnrichRaiderio !== false) await enrichCandidates(candidatesWorthHydrating(merged));

    render();
    finishRun();
}

function finishRun(emptyMessage) {
    state.running = false;
    el.run.disabled = false;
    el.run.textContent = '🔎 Run scout';
    if (emptyMessage) {
        el.empty.hidden = false;
        el.empty.textContent = emptyMessage;
        setProgress('Done.');
    }
}

// ─── Cross-referencing ─────────────────────────────────────────────────────────

// Every listing publishes a different subset of stats — a WoWProgress row has an
// item level and nothing else, so its candidates showed "—" for M+ and mythic
// progress no matter how good the player was. Fill those gaps from Raider.IO's
// public character API, which knows all three for every character regardless of
// where they advertised.
//
// Deliberately additive and silent: a lookup that fails leaves the candidate
// exactly as the listings described them, and is not warned about. Raider.IO has
// never heard of plenty of legitimate fresh alts, and four hundred "could not
// find character" lines would bury the harvest warnings that actually matter.
// Raider.IO has no bulk character endpoint — its API is one profile per request
// — so "batching" here means running more of them at once. Twelve is chosen to
// keep a full run in the low tens of seconds while staying well short of
// anything that looks like abuse; responses are cacheable for five minutes and
// the endpoint publishes no rate-limit headers, so this is a politeness ceiling
// rather than a measured one. A 429 backs the whole pass off (see below) instead
// of retrying into it.
const ENRICH_CONCURRENCY = 12;

// Only candidates still standing after scoring are worth a Raider.IO lookup.
// Hydrating a candidate the parse thresholds already rejected spends a request
// on a row the officer will not see — on a typical run that is most of them.
//
// When "hide below thresholds" is off nothing is filtered, so this returns
// everyone and the pass is exactly as it was. Rows revealed later by unticking
// that box are hydrated then (see the toolbar handler), so no row ever stays
// permanently blank because it was hidden at the moment scoring finished.
function candidatesWorthHydrating(candidates) {
    if (!el.hideBelow.checked) return candidates;
    return candidates.filter(c => !c.enriched && !isBelowThreshold(c));
}

async function enrichCandidates(candidates) {
    if (candidates.length === 0) return;

    let done = 0;
    let filled = 0;
    setProgress(`Cross-referencing 0/${candidates.length} with Raider.IO…`);

    await runWithConcurrency(candidates, async (candidate) => {
        const fields = await fetchProfileFields(candidate);
        done++;

        if (fields) {
            const before = candidate.mplusScore;
            // Mutated in place rather than replaced: state.candidates and
            // rowIndex both hold this object by reference, and swapping it would
            // leave the rendered row pointing at a stale copy.
            Object.assign(candidate, applyEnrichment(candidate, fields));
            if (before === null && candidate.mplusScore !== null) filled++;
            updateRow(candidate);
        }
        setProgress(`Cross-referencing ${done}/${candidates.length} with Raider.IO…`);
    }, ENRICH_CONCURRENCY);

    render();
    setProgress(`${candidates.length} candidates · ${filled} gained an M+ score from Raider.IO`);
}

// ─── Scoring ───────────────────────────────────────────────────────────────────

// Which role to query with. A role a site *stated* is the recruit's own advert
// and a role deduced from a DPS-only class cannot be wrong, so both are queried
// directly — one metric instead of two. A role that came from the Raider.IO
// cross-reference is neither: it is whichever spec the character last logged out
// in, which is good enough to print in a column but not to score against. Trust
// it and a raider who happens to be sitting in their off-spec gets queried on the
// wrong metric, comes back empty, and is hidden under the no-logs rule — so those
// go to 'auto' and let WarcraftLogs resolve the role from the spec they actually
// ranked as.
function scoringRole(candidate) {
    if (!candidate.role) return 'auto';
    return candidate.origins?.role === ENRICH_ORIGIN ? 'auto' : candidate.role;
}

async function scoreCandidates(candidates) {
    const credentials = await sendToBackground({ action: 'wclHasCredentials' });
    if (!credentials?.has) {
        fail('No WarcraftLogs API credentials saved, so parses were not fetched. ' +
             'Add a Client ID and Secret in Settings → WarcraftLogs to rank candidates by parse.');
        return;
    }

    let scored = 0;
    let rateLimited = false;

    setProgress(`Scoring 0/${candidates.length}…`);

    await runWithConcurrency(candidates, async (candidate) => {
        if (rateLimited) return;

        const score = await requestWclScore({
            region: candidate.region,
            realm:  candidate.realm,
            name:   candidate.name,
            // A candidate whose row markup never yielded a role is sent as
            // 'auto' so the API resolves it from the spec they actually ranked
            // as — the same contract all four content scripts use. Defaulting
            // to 'dps' here would query DPS rankings for a healer, come back
            // empty, and then hide them under the no-logs rule.
            role:   scoringRole(candidate),
        });

        candidate.wcl = score;

        // An 'auto' lookup resolves the role from the spec WarcraftLogs actually
        // ranked them as, and effectiveRole() already judges the thresholds by
        // it. Write it back so the role column and the role sort agree with the
        // judgment, instead of showing the listing's claim (or nothing at all)
        // while the row is scored as something else. Only ever set from a role
        // the API really resolved — never fabricate one. Merging finished before
        // scoring started, so `origins` is no longer consulted.
        if (score?.role && score.role !== candidate.role) {
            if (candidate.role) candidate.listedRole = candidate.role;
            candidate.role = score.role;
        }

        scored++;

        if (score?.error && score.rateLimitMs) {
            // Stop the whole pass: every further call would be refused anyway,
            // and the officer keeps the rows already scored.
            rateLimited = true;
            fail(`WarcraftLogs rate limit hit after ${scored} of ${candidates.length} candidates. ` +
                 `Scores already fetched are shown; re-run in about ${Math.ceil(score.rateLimitMs / 1000)}s ` +
                 `for the rest (cached scores make the re-run cheap).`);
        }

        updateRow(candidate);
        setProgress(`Scoring ${scored}/${candidates.length}…`);
    }, state.wclSettings.concurrency || 4);

    reportScoreErrors(candidates);

    const withScores = candidates.filter(c => c.wcl && (c.wcl.best !== null || c.wcl.median !== null)).length;
    setProgress(`${candidates.length} candidates · ${withScores} with WarcraftLogs parses`);
}

// A scoring failure hides nobody — that is the fail-open rule working — but it
// used to explain itself nowhere except each badge's hover tooltip. A lookup
// failing for *every* candidate then produced a full table of identical "⚠ WCL
// err" badges and a banner that said nothing, which is the silent-wrong-result
// Scout's fail-visible rule exists to prevent (quirk 23). One line per distinct
// failure, not per candidate: when they all fail they almost always fail
// identically, and 150 copies of one sentence is not a better error report.
function reportScoreErrors(candidates) {
    const failures = summarizeScoreErrors(candidates);
    if (failures.length === 0) return;

    // The rate limit already raised its own, more specific warning mid-pass.
    for (const { count, headline, hint } of failures.filter(f => !f.message.startsWith('RATE_LIMITED'))) {
        const scope = count === candidates.length
            ? 'No candidate could be scored'
            : `${count} of ${candidates.length} candidates could not be scored`;
        fail(`<strong>${scope}</strong> — ${escapeHtml(headline)}.` +
             (hint ? ` ${escapeHtml(hint)}` : '') +
             ` They are still listed: an unscored candidate is never hidden.`);
    }
}

// ─── Render ────────────────────────────────────────────────────────────────────

function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g, ch =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function visibleCandidates() {
    const hideBelow = el.hideBelow.checked;
    return sortCandidates(state.candidates, state.sortKey, state.sortDir)
        .filter(c => matchesQuery(c, state.query))
        .filter(c => matchesFilters(c, state.filters))
        .filter(c => !(hideBelow && isBelowThreshold(c)));
}

// Delegates entirely to the shared rule in common.js, which every site filter
// also uses: a low parse fails, no logs at all fails, and anything that could
// not be scored (no credentials, rate limit, timeout, scoring switched off) is
// always kept. Scout only needs the extra `!candidate.wcl` guard because it
// renders rows before scoring has run.
function isBelowThreshold(candidate) {
    if (!candidate.wcl) return false;                    // not scored yet
    // effectiveRole prefers the role the API resolved from the ranked spec over
    // whatever the listing markup suggested. Without it a candidate harvested as
    // 'auto' falls through thresholdsForRole's dps branch, so a healer's HPS
    // parses get measured against the DPS minimums.
    return failsWclThresholds(candidate.wcl, state.wclSettings,
                              effectiveRole(candidate.wcl, candidate.role));
}

function wclBadgeFor(candidate) {
    const score = candidate.wcl;
    if (!score) return makeBadge('pending', null, state.wclSettings, candidate.role);
    // badgeStateForScore is the shared ladder every site uses; reusing it also
    // picks up the Cloudflare 'blocked' state, which the copy here had missed
    // and rendered as a generic error. makeBadge applies effectiveRole itself.
    return makeBadge(badgeStateForScore(score), score, state.wclSettings, candidate.role);
}

// The role shown is the one the thresholds were applied against. Where that came
// from the API and disagrees with what the site listed, the disagreement is worth
// keeping: "advertised as a healer, ranks as dps" is a recruitment signal, not a
// glitch, and overwriting the pill silently would throw it away.
function roleCellHtml(candidate) {
    if (!candidate.role) return '<span class="muted">—</span>';
    if (!candidate.listedRole) {
        return `<span class="role-pill role-${escapeHtml(candidate.role)}">${escapeHtml(candidate.role)}</span>`;
    }
    const title = `Listed as ${candidate.listedRole} — WarcraftLogs ranks them as ${candidate.role}`;
    return `<span class="role-pill role-${escapeHtml(candidate.role)} role-pill--resolved" `
         + `title="${escapeHtml(title)}">${escapeHtml(candidate.role)}</span>`;
}

// The class cell carries Blizzard's class icon ahead of the name. The icon is
// decorative here — the name is right beside it — so it is alt="" rather than
// repeating the word to a screen reader.
function classCellHtml(candidate) {
    if (!candidate.playerClass) return '<span class="muted">—</span>';
    const icon = classIconUrl(candidate.playerClass);
    const label = classLabel(candidate.playerClass);
    return `<span class="class-cell class-${escapeHtml(candidate.playerClass)}">`
         + (icon ? `<img class="class-icon" src="${escapeHtml(icon)}" alt="" width="18" height="18">` : '')
         + `<span>${escapeHtml(label)}</span></span>`;
}

// Short site names rather than bare colour dots. The dots were unreadable: four
// unlabelled 8px circles asked the officer to learn a colour key, and the column
// heading "Seen on" did not say what the cell was showing. Cross-posting is the
// strongest signal in the table — someone advertising on three sites is actively
// looking — so it needs to be legible at a glance, not on hover.
const SOURCE_SHORT = {
    wowprogress: 'WP', raiderio: 'RIO', guildsofwow: 'GoW',
};

function sourcesCellHtml(candidate) {
    return `<span class="source-tags">` + candidate.sources.map(id =>
        `<span class="source-tag" style="--source-colour:${SOURCE_META[id]?.colour || '#555'}" `
        + `title="Advertising on ${escapeHtml(SOURCE_META[id]?.label || id)}">`
        + `${escapeHtml(SOURCE_SHORT[id] || id)}</span>`).join('') + `</span>`;
}

function numCell(value) {
    return value === null || value === undefined ? '<span class="muted">—</span>' : escapeHtml(value);
}

// "6/8", not "6". The denominator is what makes a kill count mean anything, and
// it changes every tier — the muted total keeps the kills the thing you scan.
function mythicCell(candidate) {
    const text = formatMythicProgress(candidate);
    if (text === null) return '<span class="muted">—</span>';
    const [killed, total] = text.split('/');
    return total
        ? `${escapeHtml(killed)}<span class="muted">/${escapeHtml(total)}</span>`
        : escapeHtml(killed);
}

function buildRow(candidate) {
    const tr = document.createElement('tr');
    if (isBelowThreshold(candidate)) tr.classList.add('below-threshold');

    const links = profileLinks(candidate);

    tr.innerHTML = `
        <td class="name-cell"><span class="char-name class-${escapeHtml(candidate.playerClass || '')}">${escapeHtml(candidate.name)}</span></td>
        <td>${escapeHtml(candidate.realm)}</td>
        <td>${escapeHtml(candidate.region.toUpperCase())}</td>
        <td class="class-col">${classCellHtml(candidate)}</td>
        <td class="role-cell">${roleCellHtml(candidate)}</td>
        <td class="num ilvl-cell">${numCell(candidate.ilvl)}</td>
        <td class="num mplus-cell">${numCell(candidate.mplusScore)}</td>
        <td class="num mythic-cell">${mythicCell(candidate)}</td>
        <td class="num wcl-cell"></td>
        <td class="sources-cell">${sourcesCellHtml(candidate)}</td>
        <td class="row-links">
            <a href="${escapeHtml(links.warcraftlogs)}" target="_blank" rel="noreferrer">WCL</a>
            <a href="${escapeHtml(links.raiderio)}" target="_blank" rel="noreferrer">RIO</a>
            ${links.wowprogress ? `<a href="${escapeHtml(links.wowprogress)}" target="_blank" rel="noreferrer">WP</a>` : ''}
        </td>`;

    tr.querySelector('.wcl-cell').appendChild(wclBadgeFor(candidate));
    if (candidate.note) tr.title = candidate.note;
    return tr;
}

function render() {
    const rows = visibleCandidates();
    el.tbody.innerHTML = '';
    state.rowIndex.clear();

    for (const candidate of rows) {
        const tr = buildRow(candidate);
        state.rowIndex.set(candidate.key, tr);
        el.tbody.appendChild(tr);
    }

    // Report no-logs separately from low parses: they are hidden for different
    // reasons and an officer short on candidates may want to reconsider one but
    // not the other.
    const hidden    = el.hideBelow.checked ? state.candidates.filter(isBelowThreshold) : [];
    const noLogs    = hidden.filter(c => hasNoLogs(c.wcl)).length;
    const lowParse  = hidden.length - noLogs;
    el.count.textContent = `${rows.length} shown` +
        (lowParse ? ` · ${lowParse} below thresholds` : '') +
        (noLogs   ? ` · ${noLogs} with no logs` : '') +
        (state.candidates.length !== rows.length + hidden.length ? ` · ${state.candidates.length} total` : '');

    el.empty.hidden = rows.length > 0;
    if (rows.length === 0 && state.candidates.length > 0) {
        // Names the checkbox as it is actually labelled in the toolbar.
        el.empty.textContent = 'Every candidate is filtered out by the search box, your parse thresholds, ' +
            'or having no WarcraftLogs data. Untick “Hide below thresholds & no logs” to see them.';
    } else if (rows.length === 0 && !el.empty.textContent) {
        // The box is unhidden whenever there are no rows, so it must never be
        // shown blank — finishRun() supplies its own message on the paths it owns.
        el.empty.textContent = 'No candidates yet. Run a scout to gather some.';
    }

    document.querySelectorAll('thead th[data-sort]').forEach(th => {
        const sorted = th.dataset.sort === state.sortKey;
        th.classList.toggle('sorted-asc',  sorted && state.sortDir === 'asc');
        th.classList.toggle('sorted-desc', sorted && state.sortDir === 'desc');
        // The ▲/▼ is CSS content, invisible to a screen reader; aria-sort is
        // what actually announces the order.
        th.setAttribute('aria-sort', sorted ? (state.sortDir === 'asc' ? 'ascending' : 'descending') : 'none');
    });
}

// Swap one row in place while scoring is still running, so the table stays live
// without re-sorting under the officer's cursor mid-pass.
function updateRow(candidate) {
    const tr = state.rowIndex.get(candidate.key);
    if (!tr) return;
    const cell = tr.querySelector('.wcl-cell');
    cell.innerHTML = '';
    cell.appendChild(wclBadgeFor(candidate));
    // Scoring resolves the role, and the Raider.IO cross-reference fills in the
    // class and the three stat columns, so every cell either pass can change is
    // refreshed here rather than left stale until the run ends and render()
    // rebuilds the table.
    tr.querySelector('.role-cell').innerHTML   = roleCellHtml(candidate);
    tr.querySelector('.class-col').innerHTML   = classCellHtml(candidate);
    tr.querySelector('.ilvl-cell').innerHTML   = numCell(candidate.ilvl);
    tr.querySelector('.mplus-cell').innerHTML  = numCell(candidate.mplusScore);
    tr.querySelector('.mythic-cell').innerHTML = mythicCell(candidate);
    tr.querySelector('.char-name').className   = `char-name class-${candidate.playerClass || ''}`;
    tr.classList.toggle('below-threshold', isBelowThreshold(candidate));
}

// ─── Filters ───────────────────────────────────────────────────────────────────

// Chips are real checkboxes in a label: keyboard handling, focus and the
// screen-reader announcement all come free, and only the box is restyled.
function buildChips(container, items, groupName) {
    container.innerHTML = '';
    for (const { value, label, colour } of items) {
        const chip = document.createElement('label');
        chip.className = 'filter-chip';
        if (colour) chip.style.setProperty('--chip-colour', colour);

        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = value;
        input.dataset.group = groupName;

        const swatch = document.createElement('span');
        swatch.className = 'chip-swatch';

        const text = document.createElement('span');
        text.textContent = label;

        chip.append(input, ...(colour ? [swatch] : []), text);
        container.appendChild(chip);
    }
}

function buildFilterControls() {
    buildChips(el.filterRoles, Object.entries(ROLE_LABELS)
        .map(([value, label]) => ({ value, label, colour: `var(--role-${value})` })), 'roles');

    buildChips(el.filterRegions, FILTER_REGIONS
        .map(value => ({ value, label: value.toUpperCase() })), 'regions');

    // WOW_CLASS_NAMES is a common.js global; classLabel spells the two
    // irregular names ('deathknight' → 'Death Knight') correctly.
    buildChips(el.filterClasses, WOW_CLASS_NAMES
        .map(value => ({ value, label: classLabel(value), colour: `var(--wow-${value.replace('_', '')})` })), 'classes');

    buildChips(el.filterSources, SOURCE_IDS
        .map(value => ({ value, label: SOURCE_META[value].label, colour: SOURCE_META[value].colour })), 'sources');
}

// State → controls. Runs on load and after Clear, never on every keystroke.
function syncFilterControls() {
    const f = state.filters;
    for (const input of el.filters.querySelectorAll('input[data-group]')) {
        input.checked = f[input.dataset.group].includes(input.value);
    }
    el.filterMultiSource.checked = f.multiSource;
    el.minIlvl.value   = f.minIlvl   || '';
    el.minMplus.value  = f.minMplus  || '';
    el.minMythic.value = f.minMythic || '';
}

// Controls → state.
function readFilterControls() {
    const group = (name) => Array.from(
        el.filters.querySelectorAll(`input[data-group="${name}"]:checked`), i => i.value);

    return normalizeFilters({
        roles:       group('roles'),
        regions:     group('regions'),
        classes:     group('classes'),
        sources:     group('sources'),
        multiSource: el.filterMultiSource.checked,
        minIlvl:     parseFloat(el.minIlvl.value),
        minMplus:    parseFloat(el.minMplus.value),
        minMythic:   parseFloat(el.minMythic.value),
    });
}

function renderFilterState() {
    const count = activeFilterCount(state.filters);
    el.filterCount.hidden = count === 0;
    el.filterCount.textContent = count;
    el.clearFilters.disabled = count === 0;
    el.filterSummary.textContent = count === 0
        ? 'No filters applied.'
        : `${count} filter${count === 1 ? '' : 's'} applied.`;
}

// Filters and sort order are remembered, so an officer who only recruits EU
// healers is not rebuilding that on every run. The search box deliberately is
// not: it answers "where is Thrall", and a query restored from a fortnight ago
// would look like a harvest that lost most of its rows.
function persistFilters() {
    chrome.storage.sync.set({
        scoutFilters: state.filters,
        scoutSortKey: state.sortKey,
        scoutSortDir: state.sortDir,
    });
}

function onFiltersChanged() {
    state.filters = readFilterControls();
    renderFilterState();
    persistFilters();
    render();
}

// Restores what was remembered from the last visit. normalizeFilters absorbs
// anything stored by an older version; the sort key is checked against the
// table's own headers, because an unknown key silently disables sorting rather
// than erroring, and the officer would just see an unordered list.
function restoreFilters(settings) {
    state.filters = normalizeFilters(settings.scoutFilters);

    const sortable = new Set(Array.from(
        document.querySelectorAll('thead th[data-sort]'), th => th.dataset.sort));
    if (sortable.has(settings.scoutSortKey)) {
        state.sortKey = settings.scoutSortKey;
        state.sortDir = settings.scoutSortDir === 'asc' ? 'asc' : 'desc';
    }

    syncFilterControls();
    renderFilterState();
    // Open the panel unprompted when something is filtering, so a short list is
    // explained by what is on screen rather than hidden behind a closed panel.
    if (activeFilterCount(state.filters) > 0) setFiltersOpen(true);
}

function setFiltersOpen(open) {
    el.filters.hidden = !open;
    el.toggleFilters.setAttribute('aria-expanded', String(open));
}

// ─── Events ────────────────────────────────────────────────────────────────────

el.run.addEventListener('click', runScout);
el.openSettings.addEventListener('click', () => chrome.runtime.openOptionsPage());

el.search.addEventListener('input', () => { state.query = el.search.value; render(); });

el.hideBelow.addEventListener('change', () => {
    chrome.storage.sync.set({ scoutHideBelowThresholds: el.hideBelow.checked });
    render();

    // Revealing the rejected candidates reveals rows the Raider.IO pass skipped,
    // because hydrating a candidate the thresholds had already discarded is a
    // request spent on a row nobody was going to see. Catch them up now, so
    // unticking the box shows complete rows rather than a column of dashes that
    // only appear when you look at the people you filtered out.
    if (!el.hideBelow.checked && !state.running &&
        state.settings.scoutEnrichRaiderio !== false) {
        const pending = state.candidates.filter(c => !c.enriched);
        if (pending.length) enrichCandidates(pending);
    }
});

el.toggleFilters.addEventListener('click', () => setFiltersOpen(el.filters.hidden));

el.toggleNotices.addEventListener('click', () => setNoticesOpen(!noticesOpen()));

// One delegated listener rather than one per control: the chips are rebuilt
// from data, so binding them individually would mean rebinding on every build.
el.filters.addEventListener('change', onFiltersChanged);
el.filters.addEventListener('input', (event) => {
    if (event.target.type === 'number') onFiltersChanged();
});

el.clearFilters.addEventListener('click', () => {
    state.filters = { ...DEFAULT_FILTERS };
    syncFilterControls();
    renderFilterState();
    persistFilters();
    render();
});

function sortBy(key) {
    if (state.sortKey === key) {
        state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc';
    } else {
        state.sortKey = key;
        // Text sorts read best A→Z; numbers and parses read best highest-first.
        state.sortDir = ['name', 'realm', 'region', 'playerClass', 'role'].includes(key) ? 'asc' : 'desc';
    }
    persistFilters();
    render();
}

document.querySelectorAll('thead th[data-sort]').forEach(th => {
    th.addEventListener('click', () => sortBy(th.dataset.sort));
    // The headers are focusable, so they have to answer the keys a button
    // would. Space is prevented first or it scrolls the page instead.
    th.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        sortBy(th.dataset.sort);
    });
});

el.copyNames.addEventListener('click', async () => {
    const text = toWhisperList(visibleCandidates());
    try {
        await navigator.clipboard.writeText(text);
        el.copyNames.textContent = '✓ Copied';
        setTimeout(() => { el.copyNames.textContent = '📋 Copy names'; }, 1500);
    } catch {
        el.copyNames.textContent = '✗ Copy failed';
        setTimeout(() => { el.copyNames.textContent = '📋 Copy names'; }, 1500);
    }
});

el.exportCsv.addEventListener('click', () => {
    const blob = new Blob([toCsv(visibleCandidates())], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `raidscout-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
});

// The table head sticks directly beneath the page header, whose height changes
// with viewport width (the actions wrap) and with its own content. Publishing
// the measured height beats the hardcoded guess it replaced, which left either
// a gap rows slid through or an overlap hiding the first row.
function trackHeaderHeight() {
    const header = document.querySelector('.scout-header');
    if (!header) return;
    const apply = () => document.documentElement.style
        .setProperty('--header-h', `${Math.round(header.getBoundingClientRect().height)}px`);
    apply();
    if (typeof ResizeObserver === 'function') new ResizeObserver(apply).observe(header);
    else window.addEventListener('resize', apply);
}

buildFilterControls();
renderFilterState();
trackHeaderHeight();

// Opened on demand from the popup — start immediately rather than making the
// officer click twice.
runScout();
