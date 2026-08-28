# Changelog

All notable changes to RaidScout are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning: [Semantic Versioning](https://semver.org/).

---

## [1.4.0] — Unreleased

### Added
- **Pre-flight scouting** — The scout flow now scores a candidate through the WarcraftLogs API *before* opening their character tab, and only opens one for candidates that pass your thresholds. Rejected candidates no longer have a tab opened and immediately closed again, so they never have to clear WarcraftLogs' Cloudflare check on the way to being discarded. Controlled by **Check parses before opening a tab** (`scoutPreflight`, default on) in the WarcraftLogs section and the popup. Requires API credentials; without them (or if a lookup fails for any reason) RaidScout falls back to the original open-then-check flow, so scouting never gets stricter because a lookup failed.
- **Open scouted tabs in the background** — New `scoutOpenInBackground` setting (default off) opens WarcraftLogs tabs without stealing focus.
- **Role auto-resolution (`role: 'auto'`)** — A single GraphQL request now fetches both the `dps` and `hps` rankings under aliases and picks the right one from the spec WarcraftLogs ranked the character as. This is what makes pre-flight possible without a page to read a spec icon from, and it replaces the guesswork on the two pages where role markup was unreliable: WoWProgress rows and the WCL recruitment search. Sites with dependable role markup (Raider.IO, Guilds of WoW) still send the role they read and skip the extra metric.
- **Cloudflare-aware API client** — A challenged request (403/503 with Cloudflare headers or an interstitial body) is now reported as `CLOUDFLARE_BLOCKED` with its own 5-minute backoff instead of a generic HTTP error. The popup and Full Settings show a countdown explaining that loading warcraftlogs.com in a tab clears it, rows get a `☁ CF check` badge, and the backoff is dropped the moment a real WarcraftLogs page renders (`wclPageReady`).
- **Skip visibility** — With no tab flashing open and shut there is nothing to see when a candidate is filtered, so Raider.IO shows a transient "skipped WarcraftLogs" notice on the character page and the popup shows the most recent skip (`getLastScoutSkip`).
- **`src/scout.js`** — Pure decision module (spec→role map, role-aware thresholds, verdict, WCL character URL parsing) shared by the service worker and covered directly by `tests/scout.test.js` (51 cases) rather than through inlined copies.

### Changed
- **The WCL character-page content script no longer needs the page.** Scores come from the API, so it asks immediately instead of polling for a spec icon, detects the Cloudflare interstitial and neither burns its attempt budget nor closes a tab mid-challenge, and applies the same role-aware thresholds the rest of the extension uses (it previously compared everyone against the DPS pair).
- **Badge counter counts skipped candidates**, from both pre-flight skips and the older open-then-close path. Popup label changed from "closed" to "skipped".
- `getApiStatus` replaces `getRateLimitStatus` — one status covering both rate-limit and Cloudflare backoff, used by the popup and Full Settings.
- `badgeStateForScore()` in `common.js` replaces the four copies of the same badge-state ladder in the site scripts; `effectiveRole()` prefers the API-resolved role over whatever the page markup suggested.

### Fixed
- **Rate-limit cooldown reported 1000× too long.** The cached-cooldown path threw `RATE_LIMITED:<ms>` while the 429 path threw `RATE_LIMITED:<seconds>`, and the consumer multiplied both by 1000 — a 60-second cooldown surfaced as a 16-hour one in the badge and status bar. Both paths now report seconds.

---

## [1.3.0] — Unreleased

### Added
- **Sort by WCL parse** — Optional "Sort by WCL parse" checkbox on WoWProgress, Raider.IO, and Guilds of WoW (`wpWclSort`/`rioWclSort`/`gowWclSort`, default off). Re-orders visible rows/cards by median (falling back to best) parse, highest first, instead of only hiding candidates below threshold. New `sortByWclScore()` helper in `common.js`.
- **Role-aware API scoring on WCL recruitment search** — New "Use role-aware API scoring" toggle (`wclSearchProactive`, default off) on the WarcraftLogs recruitment search page. Layers the same `requestWclScore`/`failsWclThresholds`/badge flow used on WoWProgress/Raider.IO/GoW on top of the existing flat `wclSearchParseThreshold` filter, giving role-aware (DPS/Healer/Tank) thresholds and inline parse badges. Requires API credentials; the original DOM-scraped flat filter still works without them.
- **Rate-limit countdown** — The rate-limit banner in the popup and Full Settings now counts down live and hides/clears itself at zero, instead of showing a single static reading.
- **Live badge count in popup** — The closed-tab counter in the popup now updates immediately via a `badgeUpdated` broadcast from the background worker instead of only reflecting the count at popup-open time.
- **Per-role WCL thresholds** — Separate Best/Median threshold pairs for DPS, Healer (HPS metric), and Tank. Healer thresholds use the `hps` WarcraftLogs metric automatically; Tank thresholds fall back to the DPS pair if not set. Available on all three list-page sites.
- **Reactive flow now uses the WCL API** — The WarcraftLogs character-page tab-close flow no longer scrapes the DOM with brittle positional CSS selectors. It now calls `fetchWclScore` via the background service worker (same API path as proactive scoring), sharing the cache and retrying gracefully if scores haven't loaded yet. Role is detected from the spec icon on the WCL page itself.
- **Configurable request concurrency** — "Max concurrent score lookups" setting (1–8, default 4) in the WarcraftLogs options panel. Controls `runWithConcurrency` across all three list-page sites.
- **Settings schema** (`src/options/settings-schema.js`) — Declarative schema that replaces the previous four-place settings pattern (defaults / load / save / HTML). `loadFromData()` and `collectFromDom()` are auto-generated from the schema; adding a new setting now requires changing one place only.
- **Improved export/import** — Export now includes `wclDebug` and `wclCacheTtlHours` in a versioned `v2` format (`{ sync, localSettings }`). Import supports both v1 (flat) and v2 formats.
- **Rate-limit indicator in popup** — Popup footer now shows "🚦 WCL rate limited — Xs remaining" when the WarcraftLogs API is throttled. Previously only visible in Full Settings.
- **Explicit `getClosedTabCount` message** — Popup now requests the closed-tab count from the background via `chrome.runtime.sendMessage` instead of reading `chrome.action.getBadgeText` implicitly.
- **WCL recruitment search `storage.onChanged`** — The class filter on the WarcraftLogs recruitment search page now reacts to settings changes at runtime without requiring a page refresh (was already working for region/parse filters; class filter was missed).
- **CHANGELOG.md** — This file.

### Changed
- **Unified WCL parse thresholds** — Parse thresholds are now configured **once** in the WarcraftLogs "Proactive Score Filter" section and drive proactive scoring on WoWProgress, Raider.IO, and Guilds of WoW; each site keeps only an on/off toggle. The DPS Best/Median values are the same `bestParseThreshold`/`parseThreshold` that auto-close a WCL character tab, so there is a single source of truth. Removed the 21 per-site keys (`wpWcl*`/`rioWcl*`/`gowWcl*` Min/Hide) in favour of shared `wclMinBestHealer`, `wclMinMedianHealer`, `wclMinBestTank`, `wclMinMedianTank`, `wclHideUnknown` (+ the existing `parseThreshold`/`bestParseThreshold`). Content scripts build the role-aware settings via the shared `buildWclSettings()` / `SHARED_WCL_KEYS` in `common.js`.
- `failsWclThresholds(score, settings, role)` — now takes a `role` argument and selects the appropriate threshold pair via `thresholdsForRole`. Callers that don't know the role pass `null`/`'dps'` and get the original behaviour.
- `makeBadge` / `setBadgeState` — now accept `role` to show correct metric label (DPS vs HPS) in badge tooltip.
- `runWithConcurrency` — limit is now passed by the caller from the `wclConcurrency` setting via `getConcurrency(options)` rather than hardcoded to 4.

### Fixed
- WCL recruitment search class filter not responding to live settings changes.
- **Raider.IO parse badge clipping** — The inline WCL parse badge on the recruitment search table was getting hard-clipped by react-table's `overflow: hidden` cell styling. `raiderio.js` now injects a scoped stylesheet that shrinks the badge and switches that cell's overflow to visible, without resizing rows (the table is virtualized on a fixed row height, so growing rows would misalign them).

---

## [1.2.0] — 2025-06

### Added
- **Proactive WarcraftLogs scoring** — Fetches each character's DPS parse from the official WCL v2 GraphQL API before the user clicks, and hides candidates below configurable thresholds on WoWProgress, Raider.IO, and Guilds of WoW.
- **WCL API client** (`src/wcl-api.js`) — OAuth client-credentials token exchange, GraphQL scoring, 6-hour `storage.local` cache with TTL, in-flight de-duplication, AbortController timeout (10 s), rate-limit backoff with `Retry-After` header.
- **Role-aware metric** — Healers scored on HPS, DPS/Tank on DPS.
- **Inline parse badges** — Every scored row/card receives a `.rs-badge` element showing Best/Median parse %. States: pending, no-logs (amber), error, rate-limited, score (green/amber/red).
- **Filter summary bar** — "RaidScout: X of Y hidden by WCL parse filter" bar injected above each list.
- **Credential test button** — "Test connection" in Full Settings does a live token exchange.
- **Configurable cache TTL** — `wclCacheTtlHours` setting (default 6).
- **Debug logging toggle** — `wclDebug` in `local` storage logs API queries/scores to the service-worker console.
- **Live settings re-evaluation** — WCL threshold changes at runtime trigger a re-scoring pass without a page refresh.
- **Badge count persistence** — `closedTabCount` persisted to `chrome.storage.session`, survives service-worker restarts.
- **Sender validation** — Background validates `sender.tab.url` hostname; `openTab` validates URL against allowed prefix.
- **Selector self-check** — `assertSelector()` logs a warning when a critical selector finds nothing.
- **Vitest test suite** — 34 unit tests for pure logic functions.
- **Popup WCL toggles** — Each site panel in the popup has a "Proactive WCL parse filter" checkbox.
- **Secret in `storage.local`** — Client secret stored locally only, never synced across devices.

### Changed
- Manifest `"type": "module"` added to the background service worker.
- WoWProgress WCL filtering hides rows (not removes) so they can be revealed on settings change.
- `wclHidden` flicker guard added to Raider.IO and GoW to prevent observer re-show loops.

---

## [1.1.0] — 2025 (prior)

### Added
- Raider.IO recruitment search filtering (ilvl, region, role, class).
- Guilds of WoW recruit filtering (ilvl, mythic kills, M+ score, class, role).
- Multi-region selection (replaced single-region dropdown).
- WarcraftLogs recruitment search parse/region/class/mythic-kill filter.

---

## [1.0.0] — 2024 (initial)

### Added
- WoWProgress player list filtering (ilvl, region, class, guild status).
- Automatic WarcraftLogs tab opening from WoWProgress character pages.
- Auto-close WarcraftLogs tab when median/best parse falls below threshold.
- Closed-tab badge counter.
- Raider.IO WarcraftLogs redirect and ad removal.
