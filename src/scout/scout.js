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
    chip.classList.remove('is-running', 'is-done', 'is-failed');
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
    // list that ignores the officer's per-site criteria.
    for (const id of sourceIds) {
        if (settings[SITE_ENABLED_KEYS[id]] === false) {
            warn(`<strong>${SOURCE_META[id].label}</strong> is switched off in settings, so its own ` +
                 `filters (item level, class, role…) were not applied to its results.`);
        }
    }

    setProgress('Harvesting…');
    const raw = [];
    let rowTotal = 0;

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

        setChip(sourceId, 'is-done', `${normalized.length}`);
        for (const w of result.warnings || []) warn(`<strong>${SOURCE_META[sourceId].label}</strong>: ${escapeHtml(w)}`);
        if (dropped > 0) {
            warn(`<strong>${SOURCE_META[sourceId].label}</strong>: ${dropped} row(s) skipped — no readable ` +
                 `character name/realm/region, so they could not be scored.`);
        }
        if (normalized.length === 0) {
            warn(`<strong>${SOURCE_META[sourceId].label}</strong> rendered but produced no candidates. ` +
                 `Its filters may be excluding everyone, or the listing URL is wrong.`);
        }
    }, HARVEST_CONCURRENCY);

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
            role:   candidate.role || 'dps',
        });

        candidate.wcl = score;
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
    return failsWclThresholds(candidate.wcl, state.wclSettings, candidate.role || 'dps');
}

function wclBadgeFor(candidate) {
    const score = candidate.wcl;
    if (!score) return makeBadge('pending', null, state.wclSettings, candidate.role);
    let badgeState = 'score';
    if (score.error && score.rateLimitMs)                                      badgeState = 'rate-limited';
    else if (score.error)                                                       badgeState = 'error';
    else if (score.notFound || (score.best === null && score.median === null))  badgeState = 'no-logs';
    return makeBadge(badgeState, score, state.wclSettings, candidate.role || 'dps');
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
        <td>${candidate.role ? `<span class="role-pill role-${escapeHtml(candidate.role)}">${escapeHtml(candidate.role)}</span>` : '<span class="muted">—</span>'}</td>
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
        el.empty.textContent = 'Every candidate is filtered out by the search box, your parse thresholds, ' +
            'or having no WarcraftLogs data. Untick “Hide below parse thresholds” to see them.';
    }

    document.querySelectorAll('thead th[data-sort]').forEach(th => {
        th.classList.remove('sorted-asc', 'sorted-desc');
        if (th.dataset.sort === state.sortKey) th.classList.add(`sorted-${state.sortDir}`);
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

document.querySelectorAll('thead th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
        const key = th.dataset.sort;
        if (state.sortKey === key) {
            state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc';
        } else {
            state.sortKey = key;
            state.sortDir = ['name', 'realm', 'region', 'playerClass', 'role'].includes(key) ? 'asc' : 'desc';
        }
        render();
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

// Opened on demand from the popup — start immediately rather than making the
// officer click twice.
runScout();
