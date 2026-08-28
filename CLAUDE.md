# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**RaidScout** is a Chrome extension designed to streamline World of Warcraft guild recruitment. It extends functionality across multiple recruitment-related websites: WarcraftLogs, WoWProgress, Raider.IO, and Guilds of WoW.

**Author:** Michael Chambers  
**Current Version:** 1.0  
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

1a. **Scout decision module** (`src/scout.js`) — ES module imported by the service worker **and by the unit tests directly**
   - `roleForSpec(spec)` — maps a WarcraftLogs spec name to `healer` / `tank` / `dps` (spec names are unambiguous across classes for role purposes)
   - `thresholdsForRole` / `failsWclThresholds` — **duplicates of the same functions in `content/common.js`**, which cannot import modules. Keep the two in sync; `tests/scout.test.js` covers this copy
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
     - `failsWclThresholds(score, {minBest, minMedian, hideUnknown})` — pure decision function; never hides on transient errors
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

4. **Full Settings Page** (`src/options/`)
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
| `wclHideUnknown` | boolean | `false` | **Shared** also hide characters WCL has no parse data for (proactive scoring) |
| `scoutPreflight` | boolean | `true` | Score a candidate via the API before opening their WCL tab; skip the tab entirely for rejects. Needs credentials — falls back to open-then-close without them |
| `scoutOpenInBackground` | boolean | `false` | Open scouted WCL tabs with `active: false` so they don't steal focus |
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

18. **Unit tests:** `tests/common.test.js` (Vitest) inlines copies of the content-script functions it covers (`normalizeClassName`, `failsWclThresholds`, `roleToMetric`, `characterKey`, `normalizeCharacter`, `extractCharacterFromUrl`) because content scripts aren't modules — keep the copies in sync when you touch the originals. `tests/scout.test.js` imports `src/scout.js` directly. Run with `npm test`.

19. **Sort by WCL parse:** `sortByWclScore()` in `common.js` re-orders a site's visible rows/cards by `dataset.wclMedian` (falling back to `dataset.wclBest`) via repeated `appendChild`, which is also how each site's scoring loop moves elements — no separate drag/drop or virtual-list logic. It only runs once per scoring batch (after `runWithConcurrency` resolves), not on every MutationObserver re-fire, so appending elements during the sort doesn't trigger an infinite reorder loop: the next observer-triggered pass finds no unscored elements left and returns early before reaching the sort step.

20. **Unreliable page role markup falls back to the API, not to `'dps'`:** `getRecruitmentRole()` (WCL recruitment search) and `getPlayerRole()` (WoWProgress) were both written against markup that couldn't be verified. They now return `null` when they can't tell, and the caller sends `role: 'auto'` so the API resolves the role from the spec the character actually ranked as. Raider.IO and GoW have dependable role markup and still send the role they read, which keeps their queries to a single metric.

21. **Pre-flight scouting fails open on purpose:** `scoutVerdict` only ever returns `reject` on a real score below threshold (or `notFound` with `wclHideUnknown` on). No credentials, an API error, a rate limit and a Cloudflare challenge all yield `unknown`, which opens the tab exactly as the pre-1.4 flow did. A broken lookup must never silently hide a candidate.

22. **Cloudflare backoff is cleared by a page load, not by time:** the 5-minute `wclCloudflareUntil` cooldown is a ceiling. What actually clears a challenge is the user loading warcraftlogs.com in a real tab, so `warcraftlogs.js` sends `wclPageReady` on any non-challenge WCL page and the background drops the backoff immediately.

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
    ├── background.js          # Service worker (ES module) — pre-flight scouting, tab management, badge, message routing
    ├── scout.js               # Pure scout decision logic (spec→role, thresholds, verdict, URL parsing) — imported by background + tests
    ├── wcl-api.js             # WarcraftLogs v2 API client — OAuth, GraphQL scoring, role auto-resolution, Cloudflare backoff, caching
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
