# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**RaidScout** is a Chrome extension designed to streamline World of Warcraft guild recruitment. It extends functionality across multiple recruitment-related websites: WarcraftLogs, WoWProgress, Raider.IO, and Guilds of WoW.

**Author:** Michael Chambers  
**Current Version:** 1.4.0  
**Type:** Chrome Extension (Manifest V3)

## Tech Stack

- **Runtime:** Chrome Browser (Manifest V3)
- **Languages:** JavaScript (ES6+)
- **Build System:** None (direct file inclusion via manifest)
- **Storage:** Chrome Storage API (sync storage)

## Architecture

### Core Components

1. **Background Service Worker** (`src/background.js`)
   - Declared as an ES module (`"type": "module"` in the manifest) so it can `import` from `wcl-api.js`
   - Handles inter-tab communication via `chrome.runtime.onMessage`
   - Listens for page navigation events via `chrome.webNavigation.onCompleted`
   - Manages automatic tab opening/closing logic (WoWProgress → WarcraftLogs)
   - **Badge count persisted to `chrome.storage.session`** and rehydrated on service-worker restart (MV3 workers are killed after ~30s idle)
   - **Sender validation**: all messages are checked against `TRUSTED_HOSTS`; untrusted senders are rejected
   - **URL validation on `openTab`**: only allows URLs starting with `https://www.warcraftlogs.com/character/` to prevent malformed-URL injection
   - **Pre-flight scouting** (`scoutAndOpenTab`): scores a candidate through the API *before* creating a WarcraftLogs tab and skips the tab entirely for candidates below threshold — see "Scout flow" below
   - Responds to (sync listener): `parseThresholdFailed`, `clearBadge`, `wclPageReady`
   - Responds to (async listener, returns `true` to keep the channel open): `openTab`, `fetchWclScore`, `wclHasCredentials`, `testWclCredentials`, `clearWclScoreCache`, `storeWclSecret`, `getApiStatus`, `getClosedTabCount`, `getLastScoutSkip`

1a. **Pre-flight decision module** (`src/preflight.js`) — ES module imported by the service worker **and by the unit tests directly**. Named for the flow, not the page: the Scout *aggregator* is `src/scout/`, an unrelated feature
   - `roleForSpec(spec)` — maps a WarcraftLogs spec name to `healer` / `tank` / `dps` (spec names are unambiguous across classes for role purposes)
   - `thresholdsForRole` / `failsWclThresholds` — **duplicates of the same functions in `content/common.js`**, which cannot import modules. Keep the two in sync; `tests/preflight.test.js` covers this copy
   - `buildScoutThresholds(options)` — storage snapshot → role-aware thresholds (same shape as `buildWclSettings` minus concurrency)
   - `scoutVerdict(score, settings, role)` → `{ verdict: 'open' | 'reject' | 'unknown', reason }`. `unknown` is the fail-open case (no credentials, API error, rate limit, Cloudflare)
   - `characterFromWclUrl` / `buildWclCharacterUrl` — WCL character URL ↔ `{region, realm, name}`

1b. **WarcraftLogs API Client** (`src/wcl-api.js`) — imported by the service worker
   - Implements the WCL v2 GraphQL API client used for **proactive** scoring (distinct from the reactive tab-open/close flow)
   - OAuth client-credentials flow: exchanges `wclClientId` + `wclClientSecret` for a bearer token via `https://www.warcraftlogs.com/oauth/token`. Token cached in memory and persisted to `chrome.storage.local` under `wclToken` until ~60s before expiry
   - **Role-aware metric**: passes `metric: hps` for healers, `metric: dps` for DPS and tanks. Role is extracted by each content script and forwarded in the `fetchWclScore` message
   - **Role auto-resolution** (`role: 'auto'`): one request fetches `dps:` and `hps:` `zoneRankings` under GraphQL aliases; `extractSpec()` reads the ranked spec (from `allStars[].spec`, falling back to `rankings[].bestSpec`) and `roleForSpec()` picks which block to read. Returns the resolved `role` and `spec` on the score. Used by the scout pre-flight (no page to read a spec icon from) and by the two sites whose role markup is unreliable — WoWProgress rows and the WCL recruitment search. Costs a slightly heavier query, so sites with dependable role markup (Raider.IO, GoW) still send the role they read
   - **Cloudflare challenge detection**: `isCloudflareChallenge()` treats a 403/503 carrying `cf-mitigated`, a challenge-page body marker, or a `cf-ray` + HTML content type as a challenge rather than an API error. Sets a 5-minute cooldown in `chrome.storage.local` under `wclCloudflareUntil` and returns `{ error: 'CLOUDFLARE_BLOCKED:<seconds>', cloudflareMs }`. Cleared by the `wclPageReady` message when a real WCL page renders
   - **Fetch timeout**: every `fetch()` call is wrapped with `AbortController` (10 s). Times out as a transient error (fail-open)
   - **Rate-limit backoff**: reads `Retry-After` header on HTTP 429, stores cooldown in `chrome.storage.local` under `wclRateLimitUntil`. Returns `{ error: 'RATE_LIMITED:<seconds>', rateLimitMs }` so content scripts can show a "rate limited" badge state
   - **Secret stored locally only** (`chrome.storage.local` → `wclClientSecret`). Client ID in sync (not sensitive). The `storeSecret()` export handles migration and wipes the secret from sync
   - **Debug logging** toggle: `wclDebug` in `chrome.storage.local`. When enabled, queries and scores are logged to the service-worker console
   - **Configurable cache TTL**: `wclCacheTtlHours` in sync storage (default 6). Cache keys: `wclScore:<region>/<realm>/<name>/<role>`; role is included so DPS/healer scores for the same alt don't collide
   - Queries `characterData.character(name, serverSlug, serverRegion).zoneRankings(metric: <dps|hps>)` and extracts `bestPerformanceAverage` / `medianPerformanceAverage`
   - In-flight request de-duplication so multiple rows asking for the same character trigger one fetch
   - `getCharacterScore()` **never throws** — returns `{ best, median, notFound?, error?, rateLimitMs? }`. Transient failures carry an `error` and are not cached; `notFound` (never logged) is cached
   - **Exports**: `getCharacterScore`, `clearScoreCache`, `hasCredentials`, `testCredentials`, `storeSecret`, `getApiStatus`, `clearCloudflareBackoff`
   - The client secret never leaves the service worker; content scripts only ever send a `{region, realm, name, role}` tuple

2. **Content Scripts** (injected per site via manifest `matches`)
   - **`src/content/common.js`** — Shared utilities injected before every other content script:
     - `normalizeClassName(name)`, `WOW_CLASS_NAMES`, `sendMessageToBackground(action, data)`
     - `assertSelector(selector, context, label)` — logs a console warning if a critical selector finds nothing, so site-markup breakage is surfaced rather than silently failing
     - `requestWclScore(character)` — asks the background for a `{best, median, notFound?, error?, rateLimitMs?}` score. `character` must include `role` so the API uses the right metric
     - `failsWclThresholds(score, settings, role)` — pure decision function. Hides low parses and no-logs characters; never hides on transient errors or unscored candidates (see quirk 29)
     - `runWithConcurrency(items, worker, limit)` — concurrency-limited async pool
     - `badgeStateForScore(score)` — maps a score result to a badge state; single source for the ladder all four sites used to repeat
     - `effectiveRole(score, fallbackRole)` — prefers the API-resolved role over whatever the page markup suggested
     - `makeBadge(state, score, thresholds)` / `setBadgeState(container, state, score, thresholds)` — renders inline parse badges with states: `pending`, `no-logs`, `error`, `rate-limited`, `blocked` (Cloudflare), `score` (with warn/fail colour coding)
     - `upsertFilterSummary(anchorEl, hidden, total)` — inserts/updates a "X of Y hidden" bar above the list
     - `watchSettings(keys, onSettingsChanged)` — wraps `chrome.storage.onChanged` so each site can re-evaluate WCL markers when settings change at runtime
     - `clearWclMarkers(elements)` — removes `wclScored` / `wclHidden` data attributes and badges so a re-pass can re-score
   - **`src/content/warcraftlogs.js`** — Backstop for pre-flight scouting: asks the API for the score (role `auto`), closes the tab if below the role-aware thresholds; detects the Cloudflare interstitial and neither burns its 20-attempt budget nor closes a tab mid-challenge; signals `wclPageReady` when a real WCL page renders
   - **`src/content/wowprogress.js`** — Filters player table rows by region, item level range, class, and guild status; uses MutationObserver + 2s polling
   - **`src/content/raiderio.js`** — Converts character URLs to WarcraftLogs; enforces search sorting/published-date params; hides ads via injected `<style>`
   - **`src/content/guildsofwow.js`** — Filters `.card` elements on the recruits list by item level, mythic kills, M+ score, class, and role; uses MutationObserver for SPA pagination; body observer waits for `#recruits-list` to appear

3. **Popup** (`src/popup/`)
   - Shown when the user clicks the extension icon
   - Context-aware: auto-expands the panel matching the active tab's site
   - 4 collapsible accordion panels (one per site), each showing the most-used settings
   - **Auto-saves** any change 400ms after user input — no Save button
   - Displays the closed-tab badge count; offers a clear button
   - "⚙ Full Settings" button calls `chrome.runtime.openOptionsPage()`
   - Does **not** include class filter (too complex for popup — that's in Full Settings only)

4. **Scout Aggregator** (`src/scout/`) — cross-site recruitment aggregator
   - Opened from the popup's "🔎 Scout all sites" button (`chrome.tabs.create` on `src/scout/scout.html`); auto-runs a harvest on load
   - **`scout-core.js`** — pure ES module (no `chrome`/`document`), imported directly by Vitest: realm slugging, candidate normalisation, cross-source merge, sorting, CSV/whisper-list export, concurrency pool
   - **`sources.js`** — adapter registry. Two harvest modes: `fetch` (request the listing + `DOMParser`; WoWProgress only) and `tab` (open the listing in a background tab, let the site's own content script filter it, harvest the visible rows, close the tab; Raider.IO, GoW). Promoting a source from `tab` to `fetch` later touches only its registry entry. WoWProgress uses **both**: it fetches first and falls back to a background tab when Cloudflare challenges the request (quirk 32)
   - **`enrich.js`** — Raider.IO public character API (`/api/v1/characters/profile`, unauthenticated) cross-reference: fills in M+ score, current-tier mythic kills, item level, class and role for *every* candidate, not just the cross-posted ones. Pure parsing with an injectable `fetch`, so `tests/enrich.test.js` imports it directly
   - **`scout.js`** — orchestration + UI. Loads `common.js` as a classic script first so it reuses `requestWclScore`, `buildWclSettings`, `failsWclThresholds` and `makeBadge` rather than reimplementing scoring. Runs three passes over the merged list: enrich (Raider.IO) → score (WarcraftLogs) → render
   - Runs the browser-rendered sources at concurrency 2 (three or four simultaneous SPA loads starve each other and cause spurious render timeouts)

5. **Full Settings Page** (`src/options/`)
   - Opened via right-click → Options or the popup's Full Settings button
   - Tab navigation (WarcraftLogs / WoWProgress / Raider.IO / Guilds of WoW)
   - Per-site enable toggle with disabled state: `syncSectionEnabledState()` in `options.js` adds `.section-disabled` to the site's `.category-content` and sets `disabled` on its controls when the site is OFF, so they grey out (CSS) and drop out of the tab order (the `disabled` attribute — `pointer-events: none` alone still lets keyboard focus reach them). The enable toggle sits in `.section-header`, which is excluded, so it stays clickable. Disabled inputs keep their values, so Save still writes them
   - Saves on explicit button click; shows `✓ Settings saved` confirmation
   - Category selection persisted in `localStorage`

### Scout flow (reactive)

1. User lands on a WoWProgress character page (`webNavigation.onCompleted`) or a Raider.IO character page (content script sends `openTab`)
2. Background calls `scoutAndOpenTab(wclUrl)`:
   - Reads `scoutPreflight` (default **on**) and the shared thresholds
   - With credentials: `getCharacterScore({...character, role: 'auto'})` → `scoutVerdict()`
   - `reject` → **no tab is opened**; records the skip in `chrome.storage.session` (`lastScoutSkip`), increments the badge, and closes the source tab (WoWProgress only, matching the old behaviour)
   - `open` / `unknown` → `chrome.tabs.create({ url, active: !scoutOpenInBackground })`
3. Raider.IO's content script gets the `{opened, verdict, score}` response and shows a transient "skipped" notice on a reject
4. If a tab did open, `warcraftlogs.js` still runs the older open-then-close check as a backstop — which is the only path for users without API credentials

**Why it matters:** WarcraftLogs is behind Cloudflare. The old flow made *every* candidate, including the ones about to be discarded, clear a Cloudflare check first. Pre-flight means only candidates worth reading ever load a WCL page. Everything fails open — a lookup that can't answer yields `unknown` and the tab opens as before.

### Data Flow

1. User configures settings in popup (auto-saved) or full settings page (save button)
2. All settings written to `chrome.storage.sync`
3. Background service worker monitors navigation events independently
4. Content script loads on target site → reads settings from storage → applies filtering/monitoring
5. Content script sends messages back to background (`parseThresholdFailed`, `openTab`)
6. Background acts: closes tabs, opens new tabs, updates badge

### Key Design Patterns

- **Message schema:** All messages use `{ action: string, ...data }` — background dispatches on `message.action`
- **MutationObserver Pattern:** `wowprogress.js`, `raiderio.js`, and `guildsofwow.js` use MutationObserver to react to dynamic DOM changes
- **Periodic Polling + Observer:** `warcraftlogs.js` polls (1s interval, 30-attempt cap); `wowprogress.js` also polls every 2s as a fallback
- **`!== false` pattern for defaults:** `options.someEnabled !== false` treats both `undefined` (never saved) and `true` as enabled
- **Per-site enable guards:** Every content script reads its `*Enabled` flag before running
- **Auto-save in popup vs explicit save in options:** Popup changes take effect immediately; options page requires Save

## Build & Deployment

**No build system required.** Load directly from source:

1. Open Chrome → `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the repository root
4. The extension icon appears; click it to open the popup

Background service workers require a manual **Inspect → reload** after code changes. Content scripts and popup reload automatically.

## Testing & Debugging

**Content script logs:** Open DevTools (F12) on the target website → Console tab.

**Background service worker logs:**
1. Go to `chrome://extensions/`
2. Click the **Service Worker** link under RaidScout

**Testing each integration:**
- **WarcraftLogs:** Navigate to any `warcraftlogs.com/character/...` page; watch console for parse metric detection
- **WoWProgress:** Visit a `wowprogress.com/gearscore/<realm>` page with `?lfg=1`; check console for filtering logs
- **Raider.IO:** Visit a `raider.io/characters/...` page; also test search at `raider.io/search?...recruitment.guild_raids`
- **Guilds of WoW:** Visit `guildsofwow.com/recruits`; watch for cards hiding as filters apply

**Reset all settings:**
```javascript
chrome.storage.sync.clear(() => console.log('Settings cleared'));
```

## Settings Reference

All stored in `chrome.storage.sync`. Defaults shown are what the extension uses when a key is absent.

### WarcraftLogs

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `warcraftlogsEnabled` | boolean | `true` | Enable/disable all WarcraftLogs features |
| `parseThreshold` | number | `50` | **Shared** min median DPS parse % — drives tab auto-close AND proactive scoring (DPS/Tank) on all sites |
| `bestParseThreshold` | number | `60` | **Shared** min best single DPS parse % — drives tab auto-close AND proactive scoring (DPS/Tank) on all sites |
| `wclMinBestHealer` | number | `0` | **Shared** min best HPS parse % for healers (proactive scoring; 0 = no minimum) |
| `wclMinMedianHealer` | number | `0` | **Shared** min median HPS parse % for healers (proactive scoring; 0 = no minimum) |
| `wclMinBestTank` | number | `0` | **Shared** min best DPS parse % for tanks — falls back to `bestParseThreshold` when 0 |
| `wclMinMedianTank` | number | `0` | **Shared** min median DPS parse % for tanks — falls back to `parseThreshold` when 0 |
| `scoutPreflight` | boolean | `true` | Score a candidate via the API before opening their WCL tab; skip the tab entirely for rejects. Needs credentials — falls back to open-then-close without them |
| `scoutOpenInBackground` | boolean | `false` | Open scouted WCL tabs with `active: false` so they don't steal focus |
| `wclSearchParseThreshold` | number | `0` | Min parse % for recruitment search results (0 = no minimum) |
| `wclSearchProactive` | boolean | `false` | Also apply the proactive API scoring flow (role-aware thresholds + inline badges) to recruitment search results, on top of the flat `wclSearchParseThreshold` filter above. Requires API credentials |
| `wclSelectedRegions` | string[] | `[]` | Filter recruitment search by region — empty shows all |
| `wclMinMythicKills` | number | `0` | Min mythic kills for recruitment search (0 = no minimum) |
| `wclSelectedClasses` | string[] | `[]` | Filter recruitment search by class — empty shows all |
| `wclClientId` | string | `""` | WarcraftLogs v2 API client ID (for proactive scoring) — stored in sync |
| `wclCacheTtlHours` | number | `6` | Score cache TTL in hours — stored in sync |
| `wclSortByParse` | boolean | `false` | **Shared** — rank candidates by parse (highest first) on every site with proactive filtering on. Replaced the per-site `wpWclSort`/`rioWclSort`/`gowWclSort` in 1.4.0; `wclSortEnabled()` in `common.js` still reads those three when the shared key is absent, so existing installs keep their choice |
| `wclClientSecret` | string | `""` | WarcraftLogs v2 API client secret — stored in **`chrome.storage.local`** only, never synced |
| `wclDebug` | boolean | `false` | Log WCL queries/scores to service-worker console — stored in `local` |

### WoWProgress

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `wowprogressEnabled` | boolean | `true` | Enable/disable all WoWProgress features |
| `openWarcraftLogsTab` | boolean | `true` | Auto-open WarcraftLogs when visiting a character page |
| `selectedRegions` | string[] | `["EU"]` | Filter players by region — empty array shows all |
| `minIlvl` | number | `0` | Minimum item level (float; 0 = no minimum) |
| `maxIlvl` | number | `0` | Maximum item level (float; 0 = no maximum) |
| `guildFilter` | string | `"any"` | Guild status: `"any"` / `"in"` / `"out"` |
| `selectedClasses` | string[] | `[]` | Allowed classes — empty array shows all |
| `wpWclEnabled` | boolean | `false` | Enable proactive WCL score filtering on the WoWProgress player table (thresholds are the shared `wcl*` keys in the WarcraftLogs section) |

> **Migration note:** The old `region` (string) key is still read as a fallback when `selectedRegions` is absent.

### Raider.IO

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `raiderioEnabled` | boolean | `true` | Enable/disable all Raider.IO features |
| `openWarcraftLogsFromRaiderIO` | boolean | `true` | Auto-open WarcraftLogs when visiting a character page |
| `hideRaiderIoAds` | boolean | `true` | Inject CSS to hide ad containers |
| `rioMinIlvl` | number | `0` | Minimum item level on the recruitment search table (0 = no minimum) |
| `rioSelectedRegions` | string[] | `[]` | Filter search rows by region (`"EU"` / `"US"` / `"OC"` / `"KR"` / `"TW"`) — empty shows all |
| `rioSelectedRoles` | string[] | `[]` | Filter search rows by main role (`"tank"` / `"healer"` / `"dps"`) — empty shows all |
| `rioSelectedClasses` | string[] | `[]` | Filter search rows by class — empty shows all (Full Settings only; not in popup) |
| `rioWclEnabled` | boolean | `false` | Enable proactive WCL score filtering on the Raider.IO search table (thresholds are the shared `wcl*` keys in the WarcraftLogs section) |

### Guilds of WoW

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `guildsofwowEnabled` | boolean | `true` | Enable/disable all Guilds of WoW features |
| `gowMinIlvl` | number | `0` | Minimum item level (0 = no minimum) |
| `gowMinMythicKills` | number | `0` | Minimum current-tier mythic kills (0 = no minimum) |
| `gowMinMythicPlusScore` | number | `0` | Minimum M+ score (0 = no minimum) |
| `gowSelectedClasses` | string[] | `[]` | Allowed classes — empty array shows all |
| `gowSelectedRoles` | string[] | `[]` | Allowed roles (`"tank"` / `"healer"` / `"dps"`) — empty shows all |
| `gowWclEnabled` | boolean | `false` | Enable proactive WCL score filtering on the recruits list (thresholds are the shared `wcl*` keys in the WarcraftLogs section) |

### Scout

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `scoutSources` | string[] | all three | Which sources a Scout run harvests (`wowprogress`, `raiderio`, `guildsofwow`) |
| `scoutMaxCandidates` | number | `150` | Cap on unique candidates scored per run (each is one WCL API call) |
| `scoutPagesPerSource` | number | `1` | WoWProgress listing pages to pull (`fetch` adapter only) |
| `scoutWclEnabled` | boolean | `true` | Fetch WarcraftLogs parses for harvested candidates |
| `scoutHideBelowThresholds` | boolean | `true` | Apply the shared parse thresholds to Scout results, and hide no-logs candidates (see quirk 29) |
| `scoutEnrichRaiderio` | boolean | `true` | Cross-reference every candidate against Raider.IO's public character API to fill in M+ score, mythic progress and item level (see quirk 39) |
| `scoutUrlWowprogress` | string | `""` | Listing URL override — blank uses `DEFAULT_SOURCE_URLS` |
| `scoutUrlRaiderio` | string | `""` | Listing URL override |
| `scoutUrlGuildsofwow` | string | `""` | Listing URL override |
| `scoutFilters` | object | all empty | Remembered Scout table filters: `{roles, classes, regions, sources, minIlvl, minMplus, minMythic, multiSource}`. Empty lists and zero minimums mean "no opinion" — see quirk 36 |
| `scoutSortKey` | string | `"wclMedian"` | Remembered Scout sort column; ignored unless it matches a `th[data-sort]` |
| `scoutSortDir` | string | `"desc"` | Remembered Scout sort direction (`"asc"` / `"desc"`) |

### WoW class name format

Class names are stored in lowercase with underscores: `warrior`, `paladin`, `hunter`, `rogue`, `priest`, `shaman`, `mage`, `warlock`, `monk`, `druid`, `deathknight`, `demon_hunter`, `evoker`.

WoWProgress uses this exact format in its DOM classlist. Guilds of WoW uses `img` alt text (e.g. `"Demon Hunter"`) and Raider.IO uses the `title` attribute on class icon spans (e.g. `"Death Knight"`). All sites normalise via the shared `normalizeClassName()` in `common.js`.

## Known Quirks & Non-Obvious Behaviors

1. **WarcraftLogs 30-attempt cap:** The extension polls for parse metrics up to 30 times (30 seconds). If the page hasn't loaded by then, the tab stays open — it will never auto-close even if the player is below threshold.

2. **WoWProgress rows are removed (not hidden):** `filterPlayers()` calls `playerRow.remove()`. Once removed, rows don't come back on the same page load. This is intentional — WoWProgress is a server-rendered pagination model, not a SPA.

3. **Guilds of WoW cards are hidden (not removed):** `guildsofwow.js` sets `card.style.display = 'none'`. Cards can reappear if settings change or the observer re-fires. GoW is a SPA with infinite scroll, so removal would break pagination.

4. **`dataset.filtered` marker on WoWProgress:** Prevents the table from being filtered twice on the same page load. The 2s polling interval also calls `observeTableChanges()` but only when `table.dataset.filtered` is absent.

5. **Raider.IO URL Conversion:** Replaces spaces in realm names with hyphens when constructing the WarcraftLogs URL (required by WarcraftLogs URL format).

6. **Storage sync timing:** `chrome.storage.sync.get()` is async. On a fast machine the content script and the storage callback race — settings may be `undefined` on the very first run. The `!== false` pattern and `|| 0` / `|| []` defaults handle this gracefully.

7. **Popup auto-save scope:** The popup saves everything it touches to storage, including settings it doesn't display (class filters). It reads them from storage, leaves them unchanged, and writes them back on every save call. There is no risk of overwriting class filter selections via the popup. The popup does **not** touch any of the proactive WCL keys, so they are likewise safe.

8. **Proactive WCL scoring is opt-in and credential-gated:** Each site has its own `*WclEnabled` flag, all default `false`. With no credentials saved, `getCharacterScore()` returns `{ error: 'NO_CREDENTIALS' }`, which `failsWclThresholds` treats as "don't hide" — so a misconfigured setup fails open (shows everyone) rather than hiding the whole list.

9. **Reactive vs proactive are independent:** The original tab-open/close flow (`webNavigation` + `warcraftlogs.js` parse polling) is untouched and works without any API credentials. Proactive scoring is an additive layer.

10. **`wclHidden` flicker guard (Raider.IO + GoW):** Both sites use a MutationObserver. WCL-hidden rows/cards are marked `dataset.wclHidden = 'true'` so the standard filter never re-shows them and triggers a hide/show loop. WoWProgress is immune because it now also hides WCL-filtered rows (matching the other sites), not removes them. The `watchSettings` / `clearWclMarkers` mechanism clears these markers when WCL settings change at runtime, enabling live re-evaluation without a page refresh.

11. **Score cache lives in `chrome.storage.local`, not `sync`:** Scores, the OAuth token, rate-limit and Cloudflare cooldowns, debug flag, and the client secret all use `local` (per-machine, not synced). Cache keys: `wclToken`, `wclRateLimitUntil`, `wclCloudflareUntil`, `wclClientSecret`, `wclDebug`, and `wclScore:<region>/<realm>/<name>/<role>`. Role is included in the cache key so the same character's DPS and healer specs get separate cache entries. An `auto` lookup writes **two** entries — under `auto` and under the resolved role — so a later role-specific request hits the cache instead of the API.

12. **Client secret is `storage.local` only (never synced):** The `storeSecret()` export in `wcl-api.js` writes to `local` and removes from `sync`. Options page calls `chrome.runtime.sendMessage({ action: 'storeWclSecret', secret })` on save and after test-connection. The client ID (not sensitive) stays in `sync` so it's available across devices without re-entry.

13. **Role-aware metric:** `requestWclScore` accepts a `role` field in the character object. `roleToMetric(role)` maps `'healer'` → `'hps'`, everything else → `'dps'`. Content scripts extract role from each row (already available on Raider.IO and GoW; inferred from spec icon on WoWProgress). This prevents healers being scored against a DPS threshold they can never meet.

14. **Fetch timeout:** All `fetch()` calls in `wcl-api.js` use `fetchWithTimeout()` with a 10 s `AbortController`. A timeout returns `error: 'FETCH_TIMEOUT'`, which `failsWclThresholds` treats as fail-open.

15. **Rate-limit backoff:** HTTP 429 reads the `Retry-After` header and stores the cooldown in `chrome.storage.local` under `wclRateLimitUntil`. Subsequent `getCharacterScore` calls return `{ error: 'RATE_LIMITED:<ms>', rateLimitMs }` without hitting the API until the cooldown expires. Content scripts show a "🚦 Rate limited" badge state. The options page polls `getRateLimitStatus` on load and displays remaining seconds.

16. **Inline parse badges:** After scoring, each row/card receives a `.rs-badge` element showing WCL Best / Median %. Badge states: `pending` (grey, ⏳), `no-logs` (amber), `error` (red), `rate-limited` (orange), `score` (green / amber warn / red fail). Styles injected once per page via `ensureBadgeStyles()`. Badges are cleared by `clearWclMarkers()` before a re-scoring pass.

17. **Sender validation:** The background validates `sender.tab.url` hostname against `TRUSTED_HOSTS` before acting on any message. `openTab` additionally validates the URL against `ALLOWED_TAB_PREFIXES` (WCL character URLs only) to prevent URL injection.

18. **Unit tests:** `tests/common.test.js` (Vitest) re-declares the content-script functions it covers (`normalizeClassName`, `failsWclThresholds`, `roleToMetric`, `characterKey`, `normalizeCharacter`, `extractCharacterFromUrl`) inline, because content scripts have no export surface — keep the copies in sync when you touch the originals. `tests/preflight.test.js` imports `src/preflight.js` (pre-flight decisions) directly; `tests/scout-core.test.js` imports `src/scout/scout-core.js` (the aggregator) directly, since both are real ES modules. `tests/sources.test.js` covers the WoWProgress HTML parser against jsdom fixtures and the tab-strip retry; `tests/enrich.test.js` covers the Raider.IO cross-reference. Run with `npm test`. CI runs the same command in a `test` job that `build` depends on, so a failing suite blocks the packaged artifact and any release cut from it.

19. **Sort by WCL parse** (one shared `wclSortByParse`, see the settings table)**:** `sortByWclScore()` in `common.js` re-orders a site's visible rows/cards by `dataset.wclMedian` (falling back to `dataset.wclBest`) via repeated `appendChild`, which is also how each site's scoring loop moves elements — no separate drag/drop or virtual-list logic. It only runs once per scoring batch (after `runWithConcurrency` resolves), not on every MutationObserver re-fire, so appending elements during the sort doesn't trigger an infinite reorder loop: the next observer-triggered pass finds no unscored elements left and returns early before reaching the sort step.

20. **Unreliable page role markup falls back to the API, not to `'dps'`:** `getRecruitmentRole()` (WCL recruitment search) and `getPlayerRole()` (WoWProgress) were both written against markup that couldn't be verified. They now return `null` when they can't tell, and the caller sends `role: 'auto'` so the API resolves the role from the spec the character actually ranked as. Raider.IO and GoW have dependable role markup and still send the role they read, which keeps their queries to a single metric.

21. **Pre-flight scouting fails open on purpose:** `scoutVerdict` only ever returns `reject` on a real score below threshold. No credentials, an API error, a rate limit and a Cloudflare challenge all yield `unknown`, which opens the tab exactly as the pre-1.4 flow did. A broken lookup must never silently hide a candidate. Note the deliberate asymmetry with quirk 29: a no-logs character is hidden by the list filters but still *gets their tab opened*, because pre-flight decides whether you may look at a profile you navigated to on purpose, not whether to shorten a page you can still read.

22. **Cloudflare backoff is cleared by a page load, not by time:** the 5-minute `wclCloudflareUntil` cooldown is a ceiling. What actually clears a challenge is the user loading warcraftlogs.com in a real tab, so `warcraftlogs.js` sends `wclPageReady` on any non-challenge WCL page and the background drops the backoff immediately.

23. **Scout fails VISIBLE, everything else fails OPEN:** every content-script filter shows a candidate on error (`failsWclThresholds` returns false for transient errors). Scout inverts this for *harvest* failures — a source that returns nothing turns its chip red and raises a banner naming the site, reason and URL. A silently-shortened aggregate list is worse than a visible error because the officer has no page to compare it against. Scoring failures still fail open: an unscored candidate is never hidden.

24. **`isTrustedSender` had to be widened for Scout:** the Scout page has no `sender.tab`, so the original host-based check rejected it. `background.js` now splits the check — `isTrustedTabSender` (host allowlist, used for the tab-bound `parseThresholdFailed`/`openTab`/`clearBadge` actions) and `isExtensionPageSender` (`sender.id === chrome.runtime.id` + extension-origin URL, no tab). Only the async listener accepts the latter, so an extension page can request scores but can never trigger a tab-bound action.

25. **Realm slugging is what makes de-duplication work:** the sites spell realms three ways (`Tarren Mill`, `tarren-mill`, `Tarren-Mill`) and apostrophes vary (`Kil'jaeden` / `Kil’jaeden`). `slugRealm()` collapses all of them; without it the same player appears once per site and gets scored once per site.

26. **Merge rules:** numeric stats (ilvl, mythic kills, M+ score) take the **higher** value across sources — each site snapshots the character at a different time and these only go up. Class and role take the **more authoritative** source per `SOURCE_META[].priority` (WoWProgress > Raider.IO > WarcraftLogs > GoW, since GoW identity is reconstructed from a Blizzard render URL). Adapters return `role: null` when unknown rather than defaulting to `'dps'`, so a guessed DPS can't beat a real healer during merge and score them against an unreachable threshold — including the WCL recruitment harvester, which maps its `'auto'` scoring sentinel back to `null` rather than storing it as a role. Priority is compared against the source that actually supplied the surviving value, tracked per-field in `candidate.origins`, **not** `sources[0]`: once a candidate has been merged the two differ, and using the first source lets a low-authority value keep winning (WoWProgress `null` → GoW `tank` → Raider.IO `healer` would keep the tank).

27. **Scout listing URLs are user-overridable by design.** Raider.IO and Guilds of WoW render their listings client-side; their JSON endpoints were never confirmed, so the defaults in `DEFAULT_SOURCE_URLS` are best-effort. Any of the three can be repointed in Settings → Scout without an extension update.

28. **Background tabs opened by Scout are always cleaned up** — `harvestViaTab` removes the tab in a `finally` block, so a timeout or a thrown adapter error can't strand a tab in the officer's window.

29. **"No logs" fails every threshold in every list filter.** `failsWclThresholds()` in `common.js` returns `true` for a definitive no-logs result — `notFound`, or a successful lookup where both metrics are null — regardless of any setting. A character with no parses cannot be judged against a parse minimum, so they are below all of them. This is unconditional by design: it replaced the `wclHideUnknown` toggle (removed in 1.4.0), because most existing installs had an explicit `false` saved and a default flip would never have reached them. The line the rule draws is between information about the *player* (`notFound` → actionable) and information about the *request* (`error`, or no score at all → says nothing about them): anything errored or unscored is always kept, so a missing API key, a disabled scoring toggle or a mid-run rate limit can never empty a page. Scout adds only a `!candidate.wcl` guard, because it renders rows before scoring runs, and uses `hasNoLogs()` from `scout-core.js` purely to report the two hide reasons separately above the table. The one exception is pre-flight scouting (quirk 21), which still opens a no-logs character's tab: a list filter shortens a page you can go on reading, whereas pre-flight decides whether you see the profile you deliberately navigated to at all, and an empty profile is itself an answer. `src/preflight.js` therefore mirrors this `failsWclThresholds` exactly but short-circuits on `hasNoWclLogs()` before it.

30. **Design tokens live in `src/shared.css`.** The palette was ~90 loose hex literals across three stylesheets, with the 13 WoW class colours written out verbatim in both `options.css` and `scout.css`. Colours are now CSS custom properties on `:root`; each surface still writes its own selectors (`.class-label.warrior` on the options page, `.class-warrior` in the Scout table) but reads one value. Loaded via a `<link>` before each page's own stylesheet.

31. **The options page toggles a class, not an inline `display`.** `showCategory()` sets `.is-active` rather than `style.display = 'block'`, because the wide-viewport layout promotes the active category to a two-column grid through a media query and an inline `display` would override it. The container was also pinned at `width: 400px`, which is why a 51-setting page scrolled forever and the tab labels ellipsised.

## File Structure

```
RaidScout/
├── manifest.json              # Extension metadata, permissions, content script routes
├── CLAUDE.md                  # This file
├── tools/
│   ├── screenshots.mjs        # Regenerates docs/screenshots (see quirk 38)
│   └── scout-fixture.mjs      # Canned listing/profiles/scores driving the Scout shots
├── README.md                  # User-facing landing page — links out to docs/
├── CHANGELOG.md
├── docs/                      # Long-form user documentation
│   ├── scout.md               # The Scout aggregator in depth
│   ├── warcraftlogs-api.md    # API credential setup, per-role thresholds, badges
│   ├── settings.md            # Every setting, by options-page tab
│   ├── troubleshooting.md
│   └── screenshots/           # README/doc images (see note below)
├── img/
│   ├── class/                 # 13 Blizzard class icons, named by storage class key
│   ├── logo-16.png
│   ├── logo-48.png
│   └── logo-128.png
└── src/
    ├── background.js          # Service worker (ES module) — pre-flight scouting, tab management, badge, message routing
    ├── preflight.js           # Pre-flight decision logic (spec→role, thresholds, verdict, URL parsing) — imported by background + tests
    ├── wcl-api.js             # WarcraftLogs v2 API client — OAuth, GraphQL scoring, role auto-resolution, Cloudflare backoff, caching
    ├── shared.css             # Design tokens (palette, WoW class + role colours) — loaded by popup, options and Scout
    ├── links.js               # Support/YouTube URLs, single source of truth
    ├── scout/                 # The Scout *aggregator page* — unrelated to preflight.js above
    │   ├── scout.html         # Scout aggregator page (opened from the popup)
    │   ├── scout.css
    │   ├── scout-core.js      # Pure ES module: normalise, merge/dedupe, sort, export
    │   ├── enrich.js          # Raider.IO character-API cross-reference (M+, mythic progress, ilvl)
    │   ├── sources.js         # Source adapters (fetch + background-tab harvest)
    │   └── scout.js           # Orchestration + table UI
    ├── popup/
    │   ├── popup.html         # Quick-access popup (extension button click)
    │   ├── popup.css
    │   └── popup.js           # Context-aware accordion, auto-save
    ├── options/
    │   ├── options.html       # Full settings page (all options)
    │   ├── options.css        # Dark theme, WoW class colours, per-site accents
    │   └── options.js         # Load/save logic, tab navigation, disabled-state wiring
    └── content/
        ├── common.js          # Shared utilities: messaging, class normalisation, constants
        ├── warcraftlogs.js    # Parse threshold monitoring + tab auto-close
        ├── wowprogress.js     # Player table filtering (region/ilvl/class/guild)
        ├── raiderio.js        # WarcraftLogs redirect, search sorting, ad hiding
        └── guildsofwow.js     # Recruit card filtering (ilvl/mythic/M+/class/role)
```

32. **WoWProgress is behind Cloudflare, so its fetch harvest falls back to a tab.** A challenge is not a bad listing URL or changed markup, which is what the harvester used to report — `isCloudflareChallenge()` in `sources.js` identifies one from `cf-mitigated`, a 403/503 carrying `cf-ray`, or the interstitial's body markers (headers are not readable in every context, so the body check stands alone). On a challenge, `harvestWowProgressWithFallback` retries through `harvestViaTab('wowprogress', …)`: the tab loads in the user's real browsing context, so a clearance they already hold applies and a JS challenge resolves itself, and `wowprogress.js`'s harvester (registered since 1.4.0 but until now never reached) reads the rows. This automates the manual step it replaces — opening wowprogress.com to clear Cloudflare before a scout run. The fetch path also sends `credentials: 'include'` so an existing `cf_clearance` cookie is reused rather than every harvest arriving unverified; whether SameSite lets that cookie through from an extension page is not guaranteed, which is why the fallback and not the cookie is what makes the case recoverable. Both paths run through `applyWowProgressFilters()`, so the fallback still honours the officer's filters when the WoWProgress integration is switched off and no content-script pass ran. An interactive (click-to-solve) challenge still defeats both, and Scout says so rather than returning a short list. Note a JSON endpoint would not help: Cloudflare acts at the zone edge, before the application, so any path on the same host is challenged identically.

33. **Scout writes the API-resolved role back onto the candidate.** An `'auto'` lookup returns the role WarcraftLogs ranked the character as, and `effectiveRole()` already judges thresholds by it — but the role column used to keep showing the listing's claim (or nothing), so a row could read "healer" while being scored as DPS. `scoreCandidates()` now assigns `score.role` to `candidate.role`, and only ever from a role the API really resolved — it never fabricates `'dps'`. The site's original claim is kept in `candidate.listedRole` when the two disagree and surfaced as a tooltip on the role pill: "advertised as a healer, ranks as dps" is a recruitment signal, not a glitch. Safe because merging is complete before scoring starts, so `origins` (quirk 26) is no longer consulted.

34. **The Scout table head sticks to a measured header, not a magic number.** `thead th` hangs off `top: var(--header-h)`, published by `trackHeaderHeight()` in `scout.js` from a `ResizeObserver` on `.scout-header`. It replaced a hardcoded `top: 88px` — which is in fact the header's height at every width where it is sticky, so this fixed no visible bug; it removes a constant in `scout.css` that silently had to track a box in another file, and it is right when that box changes (a wrapped header measures 104px, which the old value would have overlapped by 16px). Below 900px both the header and the table head go `position: static`: eleven columns overflow at that width, the page scrolls sideways, and a sticky box does not — so it would tear away from the table beneath it. An `overflow-x` wrapper is the other way to solve that and is worse here: the wrapper becomes the scrollport and breaks the sticky head outright.

35. **Scout's sortable headers are real controls.** They are `<th data-sort>` with `tabindex="0"`, Enter/Space handlers and an `aria-sort` attribute kept current by `render()` — the ▲/▼ is CSS `content`, which a screen reader never sees. Only `th[data-sort]` gets the pointer cursor and hover colour; the Links column previously advertised a sort it does not have. Repeated harvest warnings are also collapsed: sources that render but match nobody are gathered into one sentence naming them all rather than one identical sentence each, and their chip goes amber (`is-empty`) rather than the green of a source that actually found candidates.

36. **Scout's structured filters are remembered; its search box is not.** `matchesFilters()` in `scout-core.js` narrows the table by role, class, region, source, "seen on more than one site", and minimum item level / M+ score / mythic kills — all pure and unit-tested, because they decide what an officer does and does not see. Every field is opt-in (empty list, zero minimum), so the stored default hides nobody, and `normalizeFilters()` absorbs anything an older version wrote: storage outlives the code that wrote it, and a render must not throw because a list arrived as a string. **A minimum never rejects a stat the site did not report** — WoWProgress rows carry no M+ score at all, so treating absent as zero would silently drop every candidate from the sites that omit a stat, the same trap the site-side filters avoid. The filters and the sort column persist to `chrome.storage.sync`; the free-text search deliberately does not, because it answers "where is Thrall" rather than "who is worth talking to", and a query restored weeks later would read as a harvest that lost most of its rows. Because a remembered filter can shorten a list long after it was set, the count sits on the Filters button, a summary and a Clear control sit in the panel, and `restoreFilters()` opens the panel unprompted when anything is active. Chips are real checkboxes inside labels — keyboard handling, focus and screen-reader announcement come free, and only the box is restyled — with a colour swatch so a checked chip is not identified by its blue tint alone.

37. **The per-site filters were not extended, deliberately.** WoWProgress (region, item-level range, class, guild status), Raider.IO (item level, region, role, class), and Guilds of WoW (item level, mythic kills, M+ score, class, role) already filter on everything their content scripts can read reliably. Raider.IO's row reader extracts only role, class and item level; adding an M+ minimum there would mean guessing at markup that was never verified, which is the mistake quirk 20 exists to record. Scout is where filtering was genuinely thin — it had a free-text box and nothing else — and it can filter on the merged candidate, which already carries the stats each site did publish.

38. **The documentation screenshots are generated, not captured.** `tools/screenshots.mjs` renders `popup.html` and `options.html` in headless Chromium with `chrome.*` stubbed — the pages are plain HTML, so no packed extension or Chrome profile is involved — and writes `docs/screenshots/`. The stub's storage snapshot is a fully-configured install, so the shots show real values rather than empty fields; change it there, not by editing an image. The options shots are cropped to a section because `.save-area` is `position: sticky` and lands across the middle of a full-page capture. **The badge legend (`parse-badges.png`) is built by calling the real `makeBadge()` from `content/common.js`**, so the documented badge states cannot drift from the code — a new state or a changed colour shows up on the next run. The three `scout-*.png` are generated too, and the same way: `tools/scout-fixture.mjs` supplies a listing, a set of Raider.IO profiles and a set of scores, and Scout's own pipeline — the WoWProgress parser, the cross-source merge, the Raider.IO hydration, scoring, sorting and render — runs over them, so a screenshot cannot show a layout the code could not produce. Only the network boundary is stubbed: `window.fetch` plus the four `chrome.tabs` calls `harvestViaTab` uses. Two fixture details are deliberate: several candidates carry `alsoOn`, so the shot demonstrates the cross-posting the “Advertising on” column exists for, and two sit below the thresholds so the “N below thresholds” counter is a real number. Scout is served over a throwaway local HTTP server because its page is an ES module and module imports are blocked on `file://`. Serialising a fixture *function* into the page does not work — it closes over this module's arrays, throws on first call, and the run hangs at “Scoring 0/N”; pre-compute in Node and inline the data instead. Playwright is deliberately *not* in `package.json`: the project has no build step and `npm install` should stay light, so regeneration installs it with `--no-save` (the file header has the commands). Output is byte-stable across runs — verified by rerunning and hashing — so a rerun that produces a diff means a page actually changed.

39. **Raider.IO fills the stat columns the listings leave blank.** Each site publishes a different subset — a WoWProgress row carries an item level and nothing else, Raider.IO's search table adds a role, only Guilds of WoW prints all three — so before `enrich.js` a candidate's M+ and Mythic cells read "—" because of *where they advertised*, not how they play. Cross-source merging only helped the minority who cross-posted. `enrich.js` looks every candidate up on Raider.IO's public, unauthenticated character API instead, which knows all three for anyone regardless of where they posted; `host_permissions` already covers raider.io, so the requests are not subject to CORS. It is deliberately additive and silent: a lookup that fails or 400s (the normal case for a fresh alt) leaves the candidate exactly as the listings described them and raises no warning, because four hundred "could not find character" lines would bury the harvest warnings that matter. Numeric stats take the higher reading, as in `mergeCandidate`; class and role only fill gaps, since a listing's role is the recruit's own advert while Raider.IO's is a snapshot of the spec they last logged out in — and WarcraftLogs' resolved role still overrides both during scoring. "Mythic kills" means the current tier's main raid, so `currentTierMythicKills()` skips the `tier-*` aggregates and picks the largest raid of the newest expansion; an unreported stat stays `null` rather than becoming `0`, because Scout's minimum filters skip a null and reject a zero (quirk 36). A role this module supplies is tagged `origins.role = ENRICH_ORIGIN` (`'raiderio-api'`, deliberately distinct from the `'raiderio'` listing source id), and `scoringRole()` in `scout.js` sends those candidates to the API as `'auto'`: Raider.IO's role is whichever spec the character last logged out in, so trusting it would query a raider sitting in their off-spec on the wrong metric, get nothing back, and hide them under the no-logs rule. A role settled by `roleFromClass` keeps the harvest's own provenance instead, because it cannot be wrong, and is still scored with a single-metric query.

40. **Four classes settle their own role.** Hunter, mage, rogue and warlock have no tank or healer specialisation, so `roleFromClass()` in `scout-core.js` assigns `dps` from the class alone during `normalizeCandidate`. This is not the "default to `dps`" that quirk 20 and 26 forbid — those are about *guessing* when the answer is unknown, and here it cannot be anything else — so an inferred role is safe to let win a merge and is recorded in `origins` under the source that supplied the class. Every other class keeps `role: null` until a site says otherwise or WarcraftLogs resolves it from the ranked spec. Beyond the role column it also makes scoring cheaper: a candidate with a known role gets a single-metric query instead of the heavier `auto` lookup that fetches DPS and HPS rankings together.

41. **Chrome refuses tab operations while the tab strip is busy, and Scout is the one caller that notices.** `chrome.tabs.create`/`remove` reject with "Tabs cannot be edited right now (user may be dragging a tab)" during a drag *or* an unsettled animation from a tab this run just opened or closed. Scout opens and closes three or four background tabs back to back, so it hit this routinely and reported it as a harvest failure — "WarcraftLogs returned nothing: Tabs cannot be edited right now" — which says nothing about recruitment and points at no fix. `withTabRetry()` in `sources.js` retries that message and only that message (any other tabs error is real and rethrows), with a linear backoff: a drag ends when a human lets go, so exponential backoff would outlast the harvest timeout for no gain.

42. **The harvest retry budget is wall-clock, not a fixed attempt count.** Raider.IO rewrites its own query string to force the sort order; the reload plus the SPA's first render reliably outlasted the old five attempts at 700ms, so a page that would have worked was reported as "its content script never answered" with a suggested fix (reload the extension) unrelated to the cause. `requestHarvest()` now retries for 12 seconds and, when it does give up, says how many attempts it made over how long instead of naming a cause it cannot know.

43. **Raider.IO's advanced search returns nothing without `type=character`.** The listing renders its ReactTable with an empty `.rt-noData` body rather than an error, so the harvest reached Scout as *"No results rendered within 15s (selector `.rt-tr-group`)"* — which points at a markup change or a sign-in wall, neither of which was true. `.rt-tr-group` is fine; the parameter is what was missing. It is now in `DEFAULT_SOURCE_URLS.raiderio`, enforced by `enforceSortingAndPublishedColumn()` in `raiderio.js` alongside the recruitment filter and sort, and repaired in passing by `ensureRaiderioSearchParams()` in `sources.js` so an officer who saved the old URL in Settings → Scout is not stuck with a permanently empty source. Adding it to the default also removes the redirect that used to tear down the content script mid-harvest (quirk 42): with every parameter already present, `enforceSortingAndPublishedColumn()` has nothing to append.

44. **Raider.IO deleted its role column; the role now comes from the spec icon.** The table's last cell is "Published" (headers are `["", "Class", "Character", "Guild", "ILVL", "Published"]`) and the `.tank-lfg-rio` / `.healer-lfg-rio` / `.dps-lfg-rio` markers `getRowData()` read exist nowhere on the page any more, so every row parsed as an unknown role. The class cell carries two avatars — the class, then the spec (`title="Restoration"`, backed by a `spec_<class>_<spec>` sprite class) — present on 100 of 100 live rows. `getRowSpec()` reads it and `roleForSpec()` maps it, which is a *better* reading than the one it replaces: a spec names its role outright, whereas the old markers were an assertion the site had to remember to make. This is why `roleForSpec` now has a third copy, in `content/common.js` — `preflight.js` cannot be imported by a content script and `wcl-api.js` resolves the ranked spec separately. `tests/common.test.js` pins this copy, including against all 30 specs a live harvest returned.

45. **A scoring failure has to say so, not just tint a badge.** Scoring fails *open* — an unscored candidate is never hidden — but the reason lived only in each badge's hover tooltip, so a lookup failing for every candidate produced a full table of identical `⚠ WCL err` badges and a banner that said nothing. That is the silent-wrong-result quirk 23 exists to prevent, applied to scoring instead of harvesting. `summarizeScoreErrors()` / `describeScoreError()` in `scout-core.js` group the failures by message and turn each into a headline plus the fix that actually applies — separating bad credentials from a broken token endpoint (same message prefix, different remedy) and flagging a GraphQL rejection as needing an extension fix rather than a settings change. One banner line per distinct failure, not per candidate: when scoring breaks they almost always break identically.

46. **WarcraftLogs is not a Scout source, and cannot be made into one.** Scout harvested `/recruitment/` through `harvestViaTab`, which made the site behind the most aggressive Cloudflare configuration also the one most dependent on loading a real page — the exact cost pre-flight scouting (quirk 21) exists to avoid. The API cannot replace it: the v2 Client API's root Query is `characterData`, `gameData`, `guildData`, `progressRaceData`, `rateLimitData`, `reportData`, `userData`, `worldData`, `reportComponentData` and `systemReportComponentData`, and a search of all 102 published schema pages finds no recruitment type at all — the single "Recruit" in the schema is a `GuildRank` enum member. The recruitment feature's Discord integration is an outbound webhook, so there is nothing to poll there either. The adapter, its listing-URL setting (`scoutUrlWarcraftlogs`) and `registerHarvester('warcraftlogs', …)` are therefore gone, while `warcraftlogs.js`'s recruitment-page filtering stays — that serves a user browsing the page themselves, which is a different feature. `RETIRED_SOURCE_IDS` in `scout-core.js` keeps the id known so `normalizeFilters` can drop it from a stored filter: an unrecognised source left in place would match no candidate and read as a harvest that found nobody, which is the same storage-outlives-code trap quirk 36 describes.

47. **Scoring runs before hydration, and only survivors are hydrated.** The parse thresholds are what decide who an officer looks at, and WarcraftLogs answers fastest — an official API with a token, per-character caching and its own concurrency setting. Running the Raider.IO cross-reference first meant the slower pass ran over the larger set: every candidate the thresholds were about to discard was looked up anyway. `runScout` now scores, then hydrates `candidatesWorthHydrating()` — those not already hidden by `isBelowThreshold`. Unticking "hide below thresholds" reveals rows the pass skipped, so the toolbar handler hydrates the remainder then, guarded by the `enriched` flag; no row stays permanently blank because it happened to be hidden when scoring finished. With the box unticked nothing is filtered, so the pass covers everyone exactly as before.

48. **"Batching" Raider.IO means parallelism, not bulk.** Its v1 API is one character per profile request — there is no multi-character endpoint to batch into — so `ENRICH_CONCURRENCY` is the only lever, raised from 6 to 12. The endpoint publishes no rate-limit headers and its responses carry `Cache-Control: max-age=300`, so that number is a politeness ceiling rather than a measured one.

49. **Mythic progress is a fraction, not a count.** "6" is not an answer an officer can use: 6/8 is most of a tier and 6/12 is a third of one, and the denominator changes every raid. `currentTierProgress()` returns `{ killed, total, raid }` and the candidate carries `mythicTotal` alongside `mythicKills`, rendered by `formatMythicProgress()` as `6/8` with the denominator muted so the kills stay the thing you scan. `mythicTotal` is the one numeric field that does **not** merge with `preferHigher`: the boss count describes the raid rather than the player, so there is no freshest reading to prefer, and taking a maximum across sources could invent a fraction larger than the raid. It falls back to the bare count when only a listing supplied the kills (Guilds of WoW prints no boss total) and the cross-reference has not run or does not know the character.

50. **Notices are counted behind a button, not stacked above the table.** A run with four things to say pushed the results off the screen, and the one notice that mattered was styled identically to three routine ones. `state.notices` carries a level per entry — `warn()` for something worth knowing, `fail()` for a part of the run that did not work — and the header button shows the total, turning red with a warning glyph when any entry is an error, so severity is legible without opening the panel. The panel keeps `aria-live` while collapsed so a screen reader still hears a notice arrive; the count is the visual equivalent. Fixing this surfaced a latent bug: any rule setting `display` outranks the UA's `[hidden]{display:none}`, which is why the Filters badge rendered a blue "0" for no active filters — `scout.css` now resets `[hidden]` once for the whole page.

51. **`isExtensionPageSender` must not require the absence of `sender.tab`.** It did, on the assumption that an extension page has no tab — but Chrome populates `sender.tab` for anything sent from a tab, and the Scout page is opened with `chrome.tabs.create`, so it always had one. Every scoring request Scout ever made was refused with `UNTRUSTED_SENDER` and every candidate rendered a `⚠ WCL err` badge; the failure was invisible until quirk 45 surfaced the message. The trust boundary is the URL — only this extension's pages have a `chrome-extension://<our id>/` URL, and the browser sets `sender.url` — plus the `sender.id` check that keeps other extensions out. Separation from the tab-bound actions never rested on the tab check anyway: the sync listener that opens and closes tabs consults `isTrustedTabSender` alone. `tests/background-senders.test.js` pins both directions.

52. **A Cloudflare interstitial is not markup drift, and `assertSelector` must not say it is.** Cloudflare serves its challenge at the requested page's *own* URL, so a content script matched on that URL runs against the interstitial rather than the site — every selector on the page is legitimately absent. WoWProgress's `observeTableChanges()` asserted `.ratingContainer` the moment the storage callback returned, so a challenged page logged *"Selector not found (WoWProgress ratingContainer) — site markup may have changed"*, sending the user after a broken selector when the page simply was not the site yet. A self-check that cries wolf is worse than none: the next real warning is the one nobody reads.
    `isCloudflareChallengePage()` moved from `warcraftlogs.js` into `common.js` (both blocked sites need it, and both are matched by URL) and now guards `filterPlayers()` and the poll. Reporting also moved from the boot call to `handlePageNavigation()`'s poll, which warns **once**, only after `CONTAINER_GRACE_POLLS` (10s) of a real page with no container — so a slow load reads as slow, a challenge reads as nothing, and genuinely lost markup still reports. `tests/wowprogress-observer.test.js` drives the real files in jsdom with fake timers and covers all three; it was verified to fail against the pre-fix code rather than passing vacuously.
