# Changelog

All notable changes to RaidScout are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning: [Semantic Versioning](https://semver.org/).

---

## [1.3.0] — Unreleased

### Added
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
