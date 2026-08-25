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
   - Responds to (sync listener): `parseThresholdFailed`, `openTab`, `clearBadge`
   - Responds to (async listener, returns `true` to keep the channel open): `fetchWclScore`, `wclHasCredentials`, `testWclCredentials`, `clearWclScoreCache`, `storeWclSecret`, `getRateLimitStatus`

1b. **WarcraftLogs API Client** (`src/wcl-api.js`) — imported by the service worker
   - Implements the WCL v2 GraphQL API client used for **proactive** scoring (distinct from the reactive tab-open/close flow)
   - OAuth client-credentials flow: exchanges `wclClientId` + `wclClientSecret` for a bearer token via `https://www.warcraftlogs.com/oauth/token`. Token cached in memory and persisted to `chrome.storage.local` under `wclToken` until ~60s before expiry
   - **Role-aware metric**: passes `metric: hps` for healers, `metric: dps` for DPS and tanks. Role is extracted by each content script and forwarded in the `fetchWclScore` message
   - **Fetch timeout**: every `fetch()` call is wrapped with `AbortController` (10 s). Times out as a transient error (fail-open)
   - **Rate-limit backoff**: reads `Retry-After` header on HTTP 429, stores cooldown in `chrome.storage.local` under `wclRateLimitUntil`. Returns `{ error: 'RATE_LIMITED:<seconds>', rateLimitMs }` so content scripts can show a "rate limited" badge state
   - **Secret stored locally only** (`chrome.storage.local` → `wclClientSecret`). Client ID in sync (not sensitive). The `storeSecret()` export handles migration and wipes the secret from sync
   - **Debug logging** toggle: `wclDebug` in `chrome.storage.local`. When enabled, queries and scores are logged to the service-worker console
   - **Configurable cache TTL**: `wclCacheTtlHours` in sync storage (default 6). Cache keys: `wclScore:<region>/<realm>/<name>/<role>`; role is included so DPS/healer scores for the same alt don't collide
   - Queries `characterData.character(name, serverSlug, serverRegion).zoneRankings(metric: <dps|hps>)` and extracts `bestPerformanceAverage` / `medianPerformanceAverage`
   - In-flight request de-duplication so multiple rows asking for the same character trigger one fetch
   - `getCharacterScore()` **never throws** — returns `{ best, median, notFound?, error?, rateLimitMs? }`. Transient failures carry an `error` and are not cached; `notFound` (never logged) is cached
   - **Exports**: `getCharacterScore`, `clearScoreCache`, `hasCredentials`, `testCredentials`, `storeSecret`, `getRateLimitStatus`
   - The client secret never leaves the service worker; content scripts only ever send a `{region, realm, name, role}` tuple

2. **Content Scripts** (injected per site via manifest `matches`)
   - **`src/content/common.js`** — Shared utilities injected before every other content script:
     - `normalizeClassName(name)`, `WOW_CLASS_NAMES`, `sendMessageToBackground(action, data)`
     - `assertSelector(selector, context, label)` — logs a console warning if a critical selector finds nothing, so site-markup breakage is surfaced rather than silently failing
     - `requestWclScore(character)` — asks the background for a `{best, median, notFound?, error?, rateLimitMs?}` score. `character` must include `role` so the API uses the right metric
     - `failsWclThresholds(score, settings, role)` — pure decision function. Hides low parses and no-logs characters; never hides on transient errors or unscored candidates (see quirk 27)
     - `runWithConcurrency(items, worker, limit)` — concurrency-limited async pool
     - `makeBadge(state, score, thresholds)` / `setBadgeState(container, state, score, thresholds)` — renders inline parse badges with states: `pending`, `no-logs`, `error`, `rate-limited`, `score` (with warn/fail colour coding)
     - `upsertFilterSummary(anchorEl, hidden, total)` — inserts/updates a "X of Y hidden" bar above the list
     - `watchSettings(keys, onSettingsChanged)` — wraps `chrome.storage.onChanged` so each site can re-evaluate WCL markers when settings change at runtime
     - `clearWclMarkers(elements)` — removes `wclScored` / `wclHidden` data attributes and badges so a re-pass can re-score
   - **`src/content/warcraftlogs.js`** — Polls every 1s for DPS parse metrics; closes tab if below thresholds; 30s timeout cap
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
   - **`sources.js`** — adapter registry. Two harvest modes: `fetch` (request the listing + `DOMParser`; WoWProgress only) and `tab` (open the listing in a background tab, let the site's own content script filter it, harvest the visible rows, close the tab; Raider.IO, GoW, WCL recruitment). Promoting a source from `tab` to `fetch` later touches only its registry entry
   - **`scout.js`** — orchestration + UI. Loads `common.js` as a classic script first so it reuses `requestWclScore`, `buildWclSettings`, `failsWclThresholds` and `makeBadge` rather than reimplementing scoring
   - Runs the browser-rendered sources at concurrency 2 (three or four simultaneous SPA loads starve each other and cause spurious render timeouts)

5. **Full Settings Page** (`src/options/`)
   - Opened via right-click → Options or the popup's Full Settings button
   - Tab navigation (WarcraftLogs / WoWProgress / Raider.IO / Guilds of WoW)
   - Per-site enable toggle with disabled state: settings grey out and become non-interactive when a site is OFF
   - Saves on explicit button click; shows `✓ Settings saved` confirmation
   - Category selection persisted in `localStorage`

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
| `wclSearchParseThreshold` | number | `0` | Min parse % for recruitment search results (0 = no minimum) |
| `wclSearchProactive` | boolean | `false` | Also apply the proactive API scoring flow (role-aware thresholds + inline badges) to recruitment search results, on top of the flat `wclSearchParseThreshold` filter above. Requires API credentials |
| `wclSelectedRegions` | string[] | `[]` | Filter recruitment search by region — empty shows all |
| `wclMinMythicKills` | number | `0` | Min mythic kills for recruitment search (0 = no minimum) |
| `wclSelectedClasses` | string[] | `[]` | Filter recruitment search by class — empty shows all |
| `wclClientId` | string | `""` | WarcraftLogs v2 API client ID (for proactive scoring) — stored in sync |
| `wclCacheTtlHours` | number | `6` | Score cache TTL in hours — stored in sync |
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
| `wpWclSort` | boolean | `false` | Sort visible players by WCL parse (highest first) instead of only hiding those below threshold |

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
| `rioWclSort` | boolean | `false` | Sort visible search rows by WCL parse (highest first) instead of only hiding those below threshold |

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
| `gowWclSort` | boolean | `false` | Sort visible recruit cards by WCL parse (highest first) instead of only hiding those below threshold |

### Scout

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `scoutSources` | string[] | all four | Which sources a Scout run harvests |
| `scoutMaxCandidates` | number | `150` | Cap on unique candidates scored per run (each is one WCL API call) |
| `scoutPagesPerSource` | number | `1` | WoWProgress listing pages to pull (`fetch` adapter only) |
| `scoutWclEnabled` | boolean | `true` | Fetch WarcraftLogs parses for harvested candidates |
| `scoutHideBelowThresholds` | boolean | `true` | Apply the shared parse thresholds to Scout results, and hide no-logs candidates (see quirk 27) |
| `scoutUrlWowprogress` | string | `""` | Listing URL override — blank uses `DEFAULT_SOURCE_URLS` |
| `scoutUrlRaiderio` | string | `""` | Listing URL override |
| `scoutUrlGuildsofwow` | string | `""` | Listing URL override |
| `scoutUrlWarcraftlogs` | string | `""` | Listing URL override |

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

11. **Score cache lives in `chrome.storage.local`, not `sync`:** Scores, the OAuth token, rate-limit cooldown, debug flag, and the client secret all use `local` (per-machine, not synced). Cache keys: `wclToken`, `wclRateLimitUntil`, `wclClientSecret`, `wclDebug`, and `wclScore:<region>/<realm>/<name>/<role>`. Role is included in the cache key so the same character's DPS and healer specs get separate cache entries.

12. **Client secret is `storage.local` only (never synced):** The `storeSecret()` export in `wcl-api.js` writes to `local` and removes from `sync`. Options page calls `chrome.runtime.sendMessage({ action: 'storeWclSecret', secret })` on save and after test-connection. The client ID (not sensitive) stays in `sync` so it's available across devices without re-entry.

13. **Role-aware metric:** `requestWclScore` accepts a `role` field in the character object. `roleToMetric(role)` maps `'healer'` → `'hps'`, everything else → `'dps'`. Content scripts extract role from each row (already available on Raider.IO and GoW; inferred from spec icon on WoWProgress). This prevents healers being scored against a DPS threshold they can never meet.

14. **Fetch timeout:** All `fetch()` calls in `wcl-api.js` use `fetchWithTimeout()` with a 10 s `AbortController`. A timeout returns `error: 'FETCH_TIMEOUT'`, which `failsWclThresholds` treats as fail-open.

15. **Rate-limit backoff:** HTTP 429 reads the `Retry-After` header and stores the cooldown in `chrome.storage.local` under `wclRateLimitUntil`. Subsequent `getCharacterScore` calls return `{ error: 'RATE_LIMITED:<ms>', rateLimitMs }` without hitting the API until the cooldown expires. Content scripts show a "🚦 Rate limited" badge state. The options page polls `getRateLimitStatus` on load and displays remaining seconds.

16. **Inline parse badges:** After scoring, each row/card receives a `.rs-badge` element showing WCL Best / Median %. Badge states: `pending` (grey, ⏳), `no-logs` (amber), `error` (red), `rate-limited` (orange), `score` (green / amber warn / red fail). Styles injected once per page via `ensureBadgeStyles()`. Badges are cleared by `clearWclMarkers()` before a re-scoring pass.

17. **Sender validation:** The background validates `sender.tab.url` hostname against `TRUSTED_HOSTS` before acting on any message. `openTab` additionally validates the URL against `ALLOWED_TAB_PREFIXES` (WCL character URLs only) to prevent URL injection.

18. **Unit tests:** `tests/common.test.js` (Vitest) covers 34 cases across `normalizeClassName`, `failsWclThresholds`, `roleToMetric`, `characterKey`, and `normalizeCharacter` — it re-declares those functions inline because content scripts have no export surface. `tests/scout-core.test.js` covers 73 cases and imports `src/scout/scout-core.js` directly, since it is a real ES module. `tests/sources.test.js` covers the WoWProgress HTML parser against jsdom fixtures. Run with `npm test`.

19. **Sort by WCL parse:** `sortByWclScore()` in `common.js` re-orders a site's visible rows/cards by `dataset.wclMedian` (falling back to `dataset.wclBest`) via repeated `appendChild`, which is also how each site's scoring loop moves elements — no separate drag/drop or virtual-list logic. It only runs once per scoring batch (after `runWithConcurrency` resolves), not on every MutationObserver re-fire, so appending elements during the sort doesn't trigger an infinite reorder loop: the next observer-triggered pass finds no unscored elements left and returns early before reaching the sort step.

20. **WCL recruitment search proactive layer is best-effort on role detection:** Unlike WoWProgress/Raider.IO/GoW, the WCL recruitment search page's spec/role markup wasn't available to verify against the live site, so `getRecruitmentRole()` in `warcraftlogs.js` degrades gracefully to `'dps'` when it can't confidently detect healer/tank specs. Enabling `wclSearchProactive` is safe even if this misfires — DPS thresholds are just applied to a healer/tank, same fail-open behaviour as everywhere else in the codebase.

21. **Scout fails VISIBLE, everything else fails OPEN:** every content-script filter shows a candidate on error (`failsWclThresholds` returns false for transient errors). Scout inverts this for *harvest* failures — a source that returns nothing turns its chip red and raises a banner naming the site, reason and URL. A silently-shortened aggregate list is worse than a visible error because the officer has no page to compare it against. Scoring failures still fail open: an unscored candidate is never hidden.

22. **`isTrustedSender` had to be widened for Scout:** the Scout page has no `sender.tab`, so the original host-based check rejected it. `background.js` now splits the check — `isTrustedTabSender` (host allowlist, used for the tab-bound `parseThresholdFailed`/`openTab`/`clearBadge` actions) and `isExtensionPageSender` (`sender.id === chrome.runtime.id` + extension-origin URL, no tab). Only the async listener accepts the latter, so an extension page can request scores but can never trigger a tab-bound action.

23. **Realm slugging is what makes de-duplication work:** the four sites spell realms three ways (`Tarren Mill`, `tarren-mill`, `Tarren-Mill`) and apostrophes vary (`Kil'jaeden` / `Kil’jaeden`). `slugRealm()` collapses all of them; without it the same player appears once per site and gets scored once per site.

24. **Merge rules:** numeric stats (ilvl, mythic kills, M+ score) take the **higher** value across sources — each site snapshots the character at a different time and these only go up. Class and role take the **more authoritative** source per `SOURCE_META[].priority` (WoWProgress > Raider.IO > WarcraftLogs > GoW, since GoW identity is reconstructed from a Blizzard render URL). Adapters return `role: null` when unknown rather than defaulting to `'dps'`, so a guessed DPS can't beat a real healer during merge and score them against an unreachable threshold.

25. **Scout listing URLs are user-overridable by design.** Raider.IO and Guilds of WoW render their listings client-side; their JSON endpoints were never confirmed, so the defaults in `DEFAULT_SOURCE_URLS` are best-effort. Any of the four can be repointed in Settings → Scout without an extension update.

26. **Background tabs opened by Scout are always cleaned up** — `harvestViaTab` removes the tab in a `finally` block, so a timeout or a thrown adapter error can't strand a tab in the officer's window.

27. **"No logs" fails every threshold, everywhere.** `failsWclThresholds()` in `common.js` returns `true` for a definitive no-logs result — `notFound`, or a successful lookup where both metrics are null — regardless of any setting. A character with no parses cannot be judged against a parse minimum, so they are below all of them. This is unconditional by design: it replaced the `wclHideUnknown` toggle (removed in 1.4.0), because most existing installs had an explicit `false` saved and a default flip would never have reached them. The line the rule draws is between information about the *player* (`notFound` → actionable) and information about the *request* (`error`, or no score at all → says nothing about them): anything errored or unscored is always kept, so a missing API key, a disabled scoring toggle or a mid-run rate limit can never empty a page. Scout adds only a `!candidate.wcl` guard, because it renders rows before scoring runs, and uses `hasNoLogs()` from `scout-core.js` purely to report the two hide reasons separately above the table.

## File Structure

```
RaidScout/
├── manifest.json              # Extension metadata, permissions, content script routes
├── CLAUDE.md                  # This file
├── README.md                  # User-facing documentation
├── img/
│   ├── logo-16.png
│   ├── logo-48.png
│   └── logo-128.png
└── src/
    ├── background.js          # Service worker (ES module) — tab management, badge, message routing, WCL score requests
    ├── wcl-api.js             # WarcraftLogs v2 API client — OAuth, GraphQL scoring, token + score caching
    ├── scout/
    │   ├── scout.html         # Scout aggregator page (opened from the popup)
    │   ├── scout.css
    │   ├── scout-core.js      # Pure ES module: normalise, merge/dedupe, sort, export
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
