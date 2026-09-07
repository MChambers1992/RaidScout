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
    sortCandidates, matchesQuery, profileLinks, toCsv, toWhisperList, runWithConcurrency,
} from './scout-core.js';
import { adapterFor, DEFAULT_SOURCE_URLS, SITE_ENABLED_KEYS } from './sources.js';

// ─── Defaults ──────────────────────────────────────────────────────────────────

const SCOUT_DEFAULTS = {
    scoutSources:             [...SOURCE_IDS],
    scoutMaxCandidates:       150,
    scoutPagesPerSource:      1,
    scoutWclEnabled:          true,
    scoutHideBelowThresholds: true,
};

const SOURCE_URL_KEYS = {
    wowprogress:  'scoutUrlWowprogress',
    raiderio:     'scoutUrlRaiderio',
    guildsofwow:  'scoutUrlGuildsofwow',
    warcraftlogs: 'scoutUrlWarcraftlogs',
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
    running:    false,
    rowIndex:   new Map(),
    warnings:   [],
};

// ─── Elements ──────────────────────────────────────────────────────────────────

const el = {
    run:          document.getElementById('runScout'),
    openSettings: document.getElementById('openSettings'),
    chips:        document.getElementById('sourceChips'),
    progress:     document.getElementById('progressLine'),
    banner:       document.getElementById('scoutBanner'),
    toolbar:      document.getElementById('scoutToolbar'),
    search:       document.getElementById('searchBox'),
    hideBelow:    document.getElementById('hideBelowThresholds'),
    count:        document.getElementById('resultCount'),
    copyNames:    document.getElementById('copyNames'),
    exportCsv:    document.getElementById('exportCsv'),
    table:        document.getElementById('resultsTable'),
    tbody:        document.getElementById('resultsBody'),
    empty:        document.getElementById('emptyState'),
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

function renderWarnings() {
    if (state.warnings.length === 0) { el.banner.hidden = true; return; }
    el.banner.hidden = false;
    el.banner.innerHTML = '';
    const intro = document.createElement('div');
    intro.textContent = state.warnings.length === 1 ? 'One thing to know:' : 'A few things to know:';
    const list = document.createElement('ul');
    for (const warning of state.warnings) {
        const li = document.createElement('li');
        li.innerHTML = warning;
        list.appendChild(li);
    }
    el.banner.append(intro, list);
}

function warn(message) {
    if (!state.warnings.includes(message)) state.warnings.push(message);
    renderWarnings();
}

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
    state.warnings = [];
    state.candidates = [];
    state.rowIndex.clear();
    el.run.disabled = true;
    el.run.textContent = '⏳ Scouting…';
    el.banner.hidden = true;
    el.table.hidden = true;
    el.toolbar.hidden = true;
    el.empty.hidden = true;

    const settings = await loadSettings();
    state.settings = settings;
    state.wclSettings = buildWclSettings(settings);
    el.hideBelow.checked = settings.scoutHideBelowThresholds !== false;

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
            warn(`<strong>${SOURCE_META[sourceId].label}</strong> returned nothing: ${escapeHtml(result.error || 'unknown error')} ` +
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

    if (settings.scoutWclEnabled !== false) await scoreCandidates(merged);

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

// ─── Scoring ───────────────────────────────────────────────────────────────────

async function scoreCandidates(candidates) {
    const credentials = await sendToBackground({ action: 'wclHasCredentials' });
    if (!credentials?.has) {
        warn('No WarcraftLogs API credentials saved, so parses were not fetched. ' +
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
            role:   candidate.role || 'auto',
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
            warn(`WarcraftLogs rate limit hit after ${scored} of ${candidates.length} candidates. ` +
                 `Scores already fetched are shown; re-run in about ${Math.ceil(score.rateLimitMs / 1000)}s ` +
                 `for the rest (cached scores make the re-run cheap).`);
        }

        updateRow(candidate);
        setProgress(`Scoring ${scored}/${candidates.length}…`);
    }, state.wclSettings.concurrency || 4);

    const withScores = candidates.filter(c => c.wcl && (c.wcl.best !== null || c.wcl.median !== null)).length;
    setProgress(`${candidates.length} candidates · ${withScores} with WarcraftLogs parses`);
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

function buildRow(candidate) {
    const tr = document.createElement('tr');
    if (isBelowThreshold(candidate)) tr.classList.add('below-threshold');

    const links = profileLinks(candidate);
    const multi = candidate.sources.length > 1
        ? `<span class="multi-source" title="Posted on ${candidate.sources.length} sites">×${candidate.sources.length}</span>`
        : '';

    tr.innerHTML = `
        <td><span class="char-name class-${escapeHtml(candidate.playerClass || '')}">${escapeHtml(candidate.name)}</span>${multi}</td>
        <td>${escapeHtml(candidate.realm)}</td>
        <td>${escapeHtml(candidate.region.toUpperCase())}</td>
        <td>${candidate.playerClass ? escapeHtml(classLabel(candidate.playerClass)) : '<span class="muted">—</span>'}</td>
        <td class="role-cell">${roleCellHtml(candidate)}</td>
        <td class="num">${candidate.ilvl ?? '<span class="muted">—</span>'}</td>
        <td class="num">${candidate.mplusScore ?? '<span class="muted">—</span>'}</td>
        <td class="num">${candidate.mythicKills ?? '<span class="muted">—</span>'}</td>
        <td class="num wcl-cell"></td>
        <td><span class="source-dots">${candidate.sources.map(s =>
            `<span class="source-dot" style="--source-colour:${SOURCE_META[s]?.colour || '#555'}" title="${escapeHtml(SOURCE_META[s]?.label || s)}"></span>`).join('')}</span></td>
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
    // Scoring may have resolved the role, so refresh that cell too rather than
    // leaving it stale until the run finishes and render() rebuilds the table.
    tr.querySelector('.role-cell').innerHTML = roleCellHtml(candidate);
    tr.classList.toggle('below-threshold', isBelowThreshold(candidate));
}

// ─── Events ────────────────────────────────────────────────────────────────────

el.run.addEventListener('click', runScout);
el.openSettings.addEventListener('click', () => chrome.runtime.openOptionsPage());

el.search.addEventListener('input', () => { state.query = el.search.value; render(); });

el.hideBelow.addEventListener('change', () => {
    chrome.storage.sync.set({ scoutHideBelowThresholds: el.hideBelow.checked });
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

trackHeaderHeight();

// Opened on demand from the popup — start immediately rather than making the
// officer click twice.
runScout();
