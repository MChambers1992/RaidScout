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
     - `failsWclThresholds(score, {minBest, minMedian, hideUnknown})` — pure decision function; never hides on transient errors
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

4. **Full Settings Page** (`src/options/`)
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
| `wclHideUnknown` | boolean | `false` | **Shared** also hide characters WCL has no parse data for (proactive scoring) |
| `wclSearchParseThreshold` | number | `0` | Min parse % for recruitment search results (0 = no minimum) |
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

18. **Unit tests:** `tests/common.test.js` (Vitest) covers 34 cases across `normalizeClassName`, `failsWclThresholds`, `roleToMetric`, `characterKey`, and `normalizeCharacter`. Run with `npm test`.

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
