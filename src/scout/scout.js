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
    passesScoutFilters,
} from './scout-core.js';
import {
    adapterFor, DEFAULT_SOURCE_URLS, SITE_ENABLED_KEYS, fetchCharacterProfile,
} from './sources.js';

// ─── Defaults ──────────────────────────────────────────────────────────────────

const SCOUT_DEFAULTS = {
    scoutSources:             [...SOURCE_IDS],
    scoutMaxCandidates:       150,
    scoutPagesPerSource:      1,
    scoutWclEnabled:          true,
    scoutHideBelowThresholds: true,
    scoutEnrichRoles:         true,
};

const SOURCE_URL_KEYS = {
    wowprogress:  'scoutUrlWowprogress',
    raiderio:     'scoutUrlRaiderio',
    guildsofwow:  'scoutUrlGuildsofwow',
    warcraftlogs: 'scoutUrlWarcraftlogs',
};

// Two at a time: the tab-mode adapters each open a hidden window, and three or
// four simultaneous page loads starve each other of CPU on modest machines,
// which shows up as spurious "nothing rendered" timeouts. The api-mode adapter
// costs nothing here — it is a plain fetch — but the cap is per-run, not
// per-mode, and is not worth splitting for one source.
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
    filters:    null,
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
    summary:      document.getElementById('scoutSummary'),

    filters:          document.getElementById('scoutFilters'),
    toggleFilters:    document.getElementById('toggleFilters'),
    filterCount:      document.getElementById('filterCount'),
    filterRoles:      document.getElementById('filterRoles'),
    filterClasses:    document.getElementById('filterClasses'),
    filterRegions:    document.getElementById('filterRegions'),
    filterMinIlvl:    document.getElementById('filterMinIlvl'),
    filterMinMplus:   document.getElementById('filterMinMplus'),
    filterMinMythic:  document.getElementById('filterMinMythic'),
    filterMinBest:    document.getElementById('filterMinBest'),
    filterMinMedian:  document.getElementById('filterMinMedian'),
    filterGuild:      document.getElementById('filterGuild'),
    filterHideUnknown: document.getElementById('filterHideUnknown'),
    resetFilters:     document.getElementById('resetFilters'),
};

// ─── Settings ──────────────────────────────────────────────────────────────────

function loadSettings() {
    return new Promise(resolve => {
        chrome.storage.sync.get(null, data =>
            resolve({ ...SCOUT_DEFAULTS, ...FILTER_DEFAULTS, ...data }));
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
    state.filters = filtersFromSettings(settings);
    el.hideBelow.checked = settings.scoutHideBelowThresholds !== false;
    paintFilterControls();
    setFiltersOpenQuietly(!!settings.scoutFiltersOpen);

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

        // A source that cannot report roles is the quietest way this feature
        // goes wrong: every healer it returns gets scored on the DPS metric,
        // against a threshold no healer can meet, and nothing on screen says so.
        // Worth a warning rather than leaving it to be noticed in the summary.
        const roleless = normalized.filter(c => !c.role).length;
        if (roleless > normalized.length / 2 && settings.scoutEnrichRoles === false) {
            warn(`<strong>${SOURCE_META[sourceId].label}</strong> gave no role for ${roleless} of ` +
                 `${normalized.length} candidates, so they are scored on the DPS metric — healers among ` +
                 `them will look worse than they are. Turn on “Look up missing roles” in ` +
                 `Settings → Scout to fill these in.`);
        }
    }, HARVEST_CONCURRENCY);

    let merged = mergeCandidates(raw);
    const uniqueCount = merged.length;
    const duplicates = rowTotal - uniqueCount;

    const cap = Math.max(1, parseInt(settings.scoutMaxCandidates) || SCOUT_DEFAULTS.scoutMaxCandidates);
    if (merged.length > cap) {
        // Say plainly that this cap, not pagination, is the binding limit —
        // otherwise the per-source "read N of M, raise pages per source" notes
        // send the officer to a setting that cannot help until this one moves.
        warn(`Found ${merged.length} candidates but the cap is ${cap} — showing the first ${cap}. ` +
             `Raise “Max candidates per run” in Settings → Scout, or tighten your per-site filters; ` +
             `reading more pages per source will not add anything until this cap goes up. ` +
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

    await enrichMissingRoles(merged);

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

// ─── Role enrichment ───────────────────────────────────────────────────────────

// Fills in the role for candidates whose source could not report one, by asking
// Raider.IO's character-profile endpoint. Runs BEFORE scoring, because the role
// is what decides whether a candidate is measured on DPS or HPS — enriching
// afterwards would leave every healer scored against a DPS threshold.
async function enrichMissingRoles(candidates) {
    if (state.settings.scoutEnrichRoles === false) return;

    const missing = candidates.filter(c => !c.role);
    if (missing.length === 0) return;

    setProgress(`Looking up ${missing.length} missing role${missing.length === 1 ? '' : 's'}…`);
    let filled = 0;
    let done   = 0;

    await runWithConcurrency(missing, async (candidate) => {
        const profile = await fetchCharacterProfile(candidate);
        done++;
        if (profile?.role) {
            candidate.role = profile.role;
            // Free alongside the role, and only ever fills a gap.
            candidate.spec        = candidate.spec        || profile.spec;
            candidate.playerClass = candidate.playerClass || profile.playerClass;
            candidate.avatar      = candidate.avatar      || profile.avatar;
            filled++;
            updateRow(candidate);
        }
        setProgress(`Looking up missing roles… ${done}/${missing.length}`);
    }, 4);

    const stillMissing = missing.length - filled;
    if (stillMissing > 0) {
        warn(`${stillMissing} candidate${stillMissing === 1 ? '' : 's'} still have no known role ` +
             `(Raider.IO has no profile for them), so they are scored on the DPS metric — any healers ` +
             `among them will look worse than they are.`);
    }
    render();
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

    reportScoringErrors(candidates);
}

// A "⚠ WCL err" badge carries its reason in a tooltip, which is fine for one
// row and useless when every row has one — the officer would have to hover a
// hundred of them to learn there is a single cause. Group the failures by
// message and say what to do about each.
const WCL_ERROR_HINTS = [
    [/NO_CREDENTIALS/i,        'Add a Client ID and Secret in Settings → WarcraftLogs.'],
    [/FETCH_TIMEOUT/i,         'The API did not answer within 10s — check your connection, then re-run.'],
    [/invalid_client|unauthor|401|403/i,
                               'WarcraftLogs rejected those credentials. Re-enter them in ' +
                               'Settings → WarcraftLogs and use “Test connection”.'],
    [/GraphQL/i,               'WarcraftLogs accepted the login but rejected the query — this usually ' +
                               'means the API changed shape and the extension needs updating.'],
];

function wclErrorHint(message) {
    for (const [pattern, hint] of WCL_ERROR_HINTS) if (pattern.test(message)) return hint;
    return 'Turn on WCL debug logging in Settings → WarcraftLogs and check the service-worker console ' +
           'for the full response.';
}

function reportScoringErrors(candidates) {
    // Rate limiting already has its own, more specific warning.
    const failed = candidates.filter(c => c.wcl?.error && !c.wcl.rateLimitMs);
    if (failed.length === 0) return;

    const counts = new Map();
    for (const c of failed) counts.set(c.wcl.error, (counts.get(c.wcl.error) || 0) + 1);

    for (const [message, count] of [...counts].sort((a, b) => b[1] - a[1])) {
        const scope = count === candidates.length
            ? `every one of the ${count} candidates`
            : `${count} of ${candidates.length} candidates`;
        warn(`WarcraftLogs scoring failed for ${scope}: <code>${escapeHtml(message)}</code><br>` +
             escapeHtml(wclErrorHint(message)));
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
        .filter(c => passesScoutFilters(c, state.filters || {}))
        .filter(c => !(hideBelow && isBelowThreshold(c)));
}

// ─── Scout filters ─────────────────────────────────────────────────────────────
// These keys are deliberately NOT in settings-schema.js. That schema drives the
// options page, and collectFromDom() writes a value for every key it lists —
// including an empty array for any checkboxGroup whose inputs are absent. Adding
// them there without also building options-page controls would mean every
// options save silently wiped the officer's Scout filters.

const FILTER_DEFAULTS = {
    scoutFilterClasses:     [],
    scoutFilterRoles:       [],
    scoutFilterRegions:     [],
    scoutFilterMinIlvl:     0,
    scoutFilterMinMplus:    0,
    scoutFilterMinMythic:   0,
    scoutFilterMinBest:     0,
    scoutFilterMinMedian:   0,
    scoutFilterGuild:       'any',
    scoutFilterHideUnknown: false,
    scoutFiltersOpen:       false,
};

const REGION_CHOICES = ['eu', 'us', 'kr', 'tw', 'cn'];

// Storage shape → the shape passesScoutFilters() expects.
function filtersFromSettings(settings) {
    return {
        classes:        settings.scoutFilterClasses  || [],
        roles:          settings.scoutFilterRoles    || [],
        regions:        settings.scoutFilterRegions  || [],
        minIlvl:        parseFloat(settings.scoutFilterMinIlvl)   || 0,
        minMplus:       parseInt(settings.scoutFilterMinMplus)    || 0,
        minMythicKills: parseInt(settings.scoutFilterMinMythic)   || 0,
        minBestParse:   parseInt(settings.scoutFilterMinBest)     || 0,
        minMedianParse: parseInt(settings.scoutFilterMinMedian)   || 0,
        guild:          settings.scoutFilterGuild || 'any',
        hideUnknown:    !!settings.scoutFilterHideUnknown,
    };
}

function activeFilterCount(f) {
    return [
        f.classes.length, f.roles.length, f.regions.length,
        f.minIlvl > 0, f.minMplus > 0, f.minMythicKills > 0,
        f.minBestParse > 0, f.minMedianParse > 0, f.guild !== 'any',
    ].filter(Boolean).length;
}

// A toggle is a button, not a checkbox: it is the whole hit target, it carries
// its own pressed state for assistive tech, and it leaves room for an icon.
function makeToggle({ value, label, title, className = '', inner }) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `toggle ${className}`.trim();
    button.dataset.value = value;
    button.setAttribute('aria-pressed', 'false');
    if (title) button.title = title;
    button.innerHTML = inner ?? escapeHtml(label);
    return button;
}

function buildFilterControls() {
    el.filterRoles.innerHTML = '';
    for (const role of ['tank', 'healer', 'dps']) {
        el.filterRoles.appendChild(makeToggle({
            value: role,
            className: `toggle--role role-${role}`,
            title: `Only ${ROLE_LABELS[role]}`,
            inner: `<svg class="role-icon" aria-hidden="true"><use href="#role-icon-${role}"></use></svg>` +
                   `<span>${escapeHtml(ROLE_LABELS[role])}</span>`,
        }));
    }

    el.filterClasses.innerHTML = '';
    for (const cls of WOW_CLASS_NAMES) {
        const label = classLabel(cls);
        el.filterClasses.appendChild(makeToggle({
            value: cls,
            className: `toggle--class class-${cls}`,
            title: label,
            inner: `<img src="../../img/classes/${cls}.jpg" alt="${escapeHtml(label)}" ` +
                   `width="22" height="22" loading="lazy">`,
        }));
    }

    el.filterRegions.innerHTML = '';
    for (const region of REGION_CHOICES) {
        el.filterRegions.appendChild(makeToggle({
            value: region, label: region.toUpperCase(), className: 'toggle--region',
        }));
    }
}

function paintFilterControls() {
    const s = state.settings;
    const mark = (container, selected) => {
        for (const button of container.querySelectorAll('.toggle')) {
            button.setAttribute('aria-pressed', selected.includes(button.dataset.value) ? 'true' : 'false');
        }
    };
    mark(el.filterRoles,   s.scoutFilterRoles   || []);
    mark(el.filterClasses, s.scoutFilterClasses || []);
    mark(el.filterRegions, s.scoutFilterRegions || []);

    // 0 means "no minimum", which reads better as an empty box than as a zero.
    const num = (input, value) => { input.value = value > 0 ? value : ''; };
    num(el.filterMinIlvl,   parseFloat(s.scoutFilterMinIlvl)  || 0);
    num(el.filterMinMplus,  parseInt(s.scoutFilterMinMplus)   || 0);
    num(el.filterMinMythic, parseInt(s.scoutFilterMinMythic)  || 0);
    num(el.filterMinBest,   parseInt(s.scoutFilterMinBest)    || 0);
    num(el.filterMinMedian, parseInt(s.scoutFilterMinMedian)  || 0);
    el.filterGuild.value        = s.scoutFilterGuild || 'any';
    el.filterHideUnknown.checked = !!s.scoutFilterHideUnknown;

    const count = activeFilterCount(state.filters);
    el.filterCount.textContent = String(count);
    el.filterCount.hidden      = count === 0;
    el.toggleFilters.classList.toggle('is-active', count > 0);
}

function readFilterControls() {
    const pressed = container => Array.from(container.querySelectorAll('.toggle[aria-pressed="true"]'))
        .map(b => b.dataset.value);
    return {
        scoutFilterRoles:       pressed(el.filterRoles),
        scoutFilterClasses:     pressed(el.filterClasses),
        scoutFilterRegions:     pressed(el.filterRegions),
        scoutFilterMinIlvl:     parseFloat(el.filterMinIlvl.value)  || 0,
        scoutFilterMinMplus:    parseInt(el.filterMinMplus.value)    || 0,
        scoutFilterMinMythic:   parseInt(el.filterMinMythic.value)   || 0,
        scoutFilterMinBest:     parseInt(el.filterMinBest.value)     || 0,
        scoutFilterMinMedian:   parseInt(el.filterMinMedian.value)   || 0,
        scoutFilterGuild:       el.filterGuild.value,
        scoutFilterHideUnknown: el.filterHideUnknown.checked,
    };
}

function onFiltersChanged() {
    const changed = readFilterControls();
    Object.assign(state.settings, changed);
    state.filters = filtersFromSettings(state.settings);
    chrome.storage.sync.set(changed);
    paintFilterControls();
    render();
}

function setFiltersOpenQuietly(open) {
    el.filters.hidden = !open;
    el.toggleFilters.setAttribute('aria-expanded', String(open));
}

function setFiltersOpen(open) {
    setFiltersOpenQuietly(open);
    chrome.storage.sync.set({ scoutFiltersOpen: open });
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

// ─── Cell renderers ────────────────────────────────────────────────────────────

const EM_DASH = '<span class="muted">—</span>';

// Item levels arrive as floats because that is how the sites publish them
// (WoWProgress "290.81", Raider.IO "311.50"). The decimals are noise when
// scanning a column of a hundred rows, so round for display — sorting and
// filtering still use the precise value on the candidate.
function fmtIlvl(ilvl) {
    if (ilvl === null || ilvl === undefined) return EM_DASH;
    return `<span title="${escapeHtml(String(ilvl))}">${Math.round(ilvl)}</span>`;
}

// Class gets an icon-only column: the name is redundant next to the artwork and
// the class colour, and the spec beneath the character name already says it in
// words. Keeping the column (rather than folding it into the name cell) is what
// keeps class sortable.
function classCellHtml(playerClass) {
    if (!playerClass) return EM_DASH;
    const label = classLabel(playerClass);
    return `<span class="class-cell class-${escapeHtml(playerClass)}" title="${escapeHtml(label)}">` +
           `<img class="class-icon" src="../../img/classes/${escapeHtml(playerClass)}.jpg" ` +
                `alt="${escapeHtml(label)}" width="22" height="22" loading="lazy"></span>`;
}

// Avatar + name + a "Spec Class · guild" subline. The avatar only exists for
// candidates Raider.IO's API returned; everything else falls back to a
// class-coloured monogram so the column never goes ragged.
function characterCellHtml(candidate) {
    const cls  = candidate.playerClass || '';
    const sub  = [candidate.spec, candidate.guild].filter(Boolean).join(' · ');
    const face = candidate.avatar
        ? `<img class="avatar" src="${escapeHtml(candidate.avatar)}" alt="" width="30" height="30" loading="lazy">`
        : `<span class="avatar avatar--initial">${escapeHtml([...candidate.name][0] || '?')}</span>`;
    const multi = candidate.sources.length > 1
        ? `<span class="multi-source" title="Posted on ${candidate.sources.length} sites">×${candidate.sources.length}</span>`
        : '';

    return `<span class="char-cell class-${escapeHtml(cls)}">${face}` +
           `<span class="char-text">` +
           `<span class="char-line"><span class="char-name">${escapeHtml(candidate.name)}</span>${multi}</span>` +
           `<span class="char-sub">${sub ? escapeHtml(sub) : '&nbsp;'}</span>` +
           `</span></span>`;
}

function realmCellHtml(candidate) {
    return `<span class="realm-cell"><span class="realm-name">${escapeHtml(candidate.realm)}</span>` +
           `<span class="region-tag">${escapeHtml(candidate.region.toUpperCase())}</span></span>`;
}

// "DPS" is an initialism, so CSS `capitalize` produced "Dps". Label it here
// instead of letting the stylesheet guess.
const ROLE_LABELS = { tank: 'Tank', healer: 'Healer', dps: 'DPS' };

function roleCellHtml(role) {
    if (!role) return EM_DASH;
    const label = ROLE_LABELS[role] || role;
    return `<span class="role-cell role-${escapeHtml(role)}">` +
           `<svg class="role-icon" aria-hidden="true"><use href="#role-icon-${escapeHtml(role)}"></use></svg>` +
           `<span class="role-name">${escapeHtml(label)}</span></span>`;
}

function sourceCellHtml(sources) {
    return `<span class="source-pills">${sources.map(s => {
        const meta = SOURCE_META[s];
        return `<span class="source-pill" style="--source-colour:${meta?.colour || '#555'}" ` +
               `title="${escapeHtml(meta?.label || s)}">${escapeHtml(meta?.abbr || s)}</span>`;
    }).join('')}</span>`;
}

// A parse is a percentile, so it has a natural 0–100 scale — which means it can
// be drawn rather than only printed. The bar shows median (the number that
// actually predicts performance) with a tick for best, so an officer can rank a
// screenful by eye instead of reading every figure.
function wclCellHtml(candidate) {
    const score = candidate.wcl;
    if (!score || score.error || score.notFound) return '';   // badge-only states
    const { best, median } = score;
    if (best === null && median === null) return '';

    const pct  = v => v === null ? null : Math.max(0, Math.min(100, v));
    const band = v => v === null ? '' : v >= 75 ? 'is-high' : v >= 50 ? 'is-mid' : 'is-low';
    const m = pct(median), b = pct(best);

    return `<span class="parse ${band(m ?? b)}">` +
           `<span class="parse-nums"><b>${m !== null ? Math.round(m) : '?'}</b>` +
           `<span class="parse-best">/ ${b !== null ? Math.round(b) : '?'}</span></span>` +
           `<span class="parse-track">` +
           `<span class="parse-fill" style="width:${m ?? 0}%"></span>` +
           (b !== null ? `<span class="parse-tick" style="left:${b}%"></span>` : '') +
           `</span></span>`;
}

function buildRow(candidate) {
    const tr = document.createElement('tr');
    if (isBelowThreshold(candidate)) tr.classList.add('below-threshold');

    const links = profileLinks(candidate);

    tr.innerHTML = `
        <td>${characterCellHtml(candidate)}</td>
        <td>${realmCellHtml(candidate)}</td>
        <td class="col-class">${classCellHtml(candidate.playerClass)}</td>
        <td>${roleCellHtml(candidate.role)}</td>
        <td class="num">${fmtIlvl(candidate.ilvl)}</td>
        <td class="num">${candidate.mplusScore ?? EM_DASH}</td>
        <td class="num">${candidate.mythicKills ?? EM_DASH}</td>
        <td class="wcl-cell"></td>
        <td>${sourceCellHtml(candidate.sources)}</td>
        <td class="row-links">
            <a href="${escapeHtml(links.warcraftlogs)}" target="_blank" rel="noreferrer">WCL</a>
            <a href="${escapeHtml(links.raiderio)}" target="_blank" rel="noreferrer">RIO</a>
            ${links.wowprogress ? `<a href="${escapeHtml(links.wowprogress)}" target="_blank" rel="noreferrer">WP</a>` : ''}
        </td>`;

    fillWclCell(tr.querySelector('.wcl-cell'), candidate);
    if (candidate.note) tr.title = candidate.note;
    return tr;
}

// A scored candidate gets the bar; every other state (pending, no logs, error,
// rate limited) keeps the badge, because those need words and a tooltip rather
// than a position on a 0-100 scale.
function fillWclCell(cell, candidate) {
    const bar = wclCellHtml(candidate);
    if (bar) { cell.innerHTML = bar; return; }
    cell.innerHTML = '';
    cell.appendChild(wclBadgeFor(candidate));
}

// ─── Summary strip ─────────────────────────────────────────────────────────────

function medianOf(values) {
    if (values.length === 0) return null;
    const s = [...values].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function renderSummary(candidates) {
    if (candidates.length === 0) { el.summary.hidden = true; return; }

    const byRole = { tank: 0, healer: 0, dps: 0 };
    let unknownRole = 0;
    for (const c of candidates) {
        if (c.role && c.role in byRole) byRole[c.role]++;
        else unknownRole++;
    }

    const parses = candidates.map(c => c.wcl?.median).filter(v => typeof v === 'number');
    const med    = medianOf(parses);

    const tile = (label, value, extra = '') =>
        `<span class="stat ${extra}"><span class="stat-value">${value}</span>` +
        `<span class="stat-label">${label}</span></span>`;
    const roleTile = role =>
        `<span class="stat stat--role role-${role}">` +
        `<svg class="role-icon" aria-hidden="true"><use href="#role-icon-${role}"></use></svg>` +
        `<span class="stat-value">${byRole[role]}</span>` +
        `<span class="stat-label">${escapeHtml(ROLE_LABELS[role])}</span></span>`;

    el.summary.innerHTML =
        tile('candidates', candidates.length) +
        roleTile('tank') + roleTile('healer') + roleTile('dps') +
        (unknownRole ? tile('role unknown', unknownRole) : '') +
        tile('with parses', parses.length) +
        (med !== null ? tile('median parse', Math.round(med)) : '');
    el.summary.hidden = false;
}

function render() {
    const rows = visibleCandidates();
    renderSummary(state.candidates);
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
    fillWclCell(tr.querySelector('.wcl-cell'), candidate);
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

el.toggleFilters.addEventListener('click', () => setFiltersOpen(el.filters.hidden));

// One delegated listener per toggle row rather than one per button, so rebuilding
// the rows never leaks handlers.
for (const row of [el.filterRoles, el.filterClasses, el.filterRegions]) {
    row.addEventListener('click', event => {
        const button = event.target.closest('.toggle');
        if (!button) return;
        button.setAttribute('aria-pressed',
            button.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
        onFiltersChanged();
    });
}

for (const input of [el.filterMinIlvl, el.filterMinMplus, el.filterMinMythic,
                     el.filterMinBest, el.filterMinMedian]) {
    input.addEventListener('input', onFiltersChanged);
}
el.filterGuild.addEventListener('change', onFiltersChanged);
el.filterHideUnknown.addEventListener('change', onFiltersChanged);

el.resetFilters.addEventListener('click', () => {
    Object.assign(state.settings, FILTER_DEFAULTS, { scoutFiltersOpen: true });
    state.filters = filtersFromSettings(state.settings);
    chrome.storage.sync.set({ ...FILTER_DEFAULTS, scoutFiltersOpen: true });
    paintFilterControls();
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

// The table header sticks below the page header, whose height depends on the
// logo and the two title lines. Publishing the measured height beats hardcoding
// an offset that silently drifts whenever the header changes.
function publishHeaderHeight() {
    const header = document.querySelector('.scout-header');
    if (!header) return;
    document.documentElement.style.setProperty('--header-h', `${Math.round(header.offsetHeight)}px`);
}
publishHeaderHeight();
addEventListener('resize', publishHeaderHeight);

buildFilterControls();

// Opened on demand from the popup — start immediately rather than making the
// officer click twice.
runScout();
