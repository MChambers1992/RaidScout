# Changelog

All notable changes to RaidScout are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning: [Semantic Versioning](https://semver.org/).

---

## [1.5.0] — 2026-09-09

### Added
- **Scout cross-references every candidate with Raider.IO** (`src/scout/enrich.js`) — The four listings publish different stats: a WoWProgress row carries an item level and nothing else, only Guilds of WoW prints M+ score *and* mythic progress. So those columns were blank for most candidates because of where they advertised, not how they play. Scout now looks each one up on Raider.IO's public character API (no key, no sign-in) and fills in M+ score, current-tier mythic kills, item level, class and spec. Additive and silent: a stat takes the higher of the two readings, a role a site stated is never overwritten, and a lookup Raider.IO can't answer leaves the row exactly as harvested. Controlled by **Cross-reference stats with Raider.IO** (`scoutEnrichRaiderio`, default on) in Settings → Scout.
- **Class icons in the Scout table** — Blizzard's class icon now sits ahead of the class name. The 13 icons are bundled under `img/class/`, so the table renders the same offline and makes no third-party request to draw a row.
- **Roles deduced from class** — Hunter, mage, rogue and warlock have no tank or healer specialisation, so `roleFromClass()` assigns their role from the class alone. Unlike a guessed default this cannot be wrong, so it fills the role column, survives a merge, and lets those candidates be scored with a single-metric WarcraftLogs query instead of the heavier role-resolving one.

### Changed
- **Scout scores before it cross-references, and only hydrates survivors** — Parse thresholds decide who you look at, and WarcraftLogs answers fastest, so running Raider.IO first meant the slower pass ran over the larger set. Scoring now runs first and Raider.IO is asked only about candidates still standing; unticking “hide below thresholds” hydrates the rest on demand, so no row stays blank. Raider.IO has no bulk endpoint, so its lookups are parallelised harder (6 → 12 at a time) rather than batched.
- **Mythic progress reads “6/8” instead of “6”** — A kill count with no denominator can't be compared to anything, and the denominator changes every tier. The boss total comes from the same Raider.IO cross-reference that supplies the M+ score, and falls back to a bare count when only a listing reported the kills.
- **Warnings and errors are counted behind a Notices button** — A run with several things to say used to push the results off the screen, with the notice that mattered styled identically to the routine ones. They now sit behind a button beside Settings showing a count, which turns red when any entry is a failure. Also fixes the Filters badge showing a blue “0” when no filters were active.
- **The Scout "Seen on" column is now "Advertising on", with named tags** — Four unlabelled colour dots asked you to learn a colour key for one of the most useful facts in the table. Each site a candidate posted on is now a readable `WP` / `RIO` / `WCL` / `GoW` tag in its source colour, which also replaces the separate `×N` marker on the name.

### Fixed
- **WoWProgress falsely reported changed markup during a Cloudflare check** — Cloudflare serves its challenge at the listing's own URL, so the content script ran against the interstitial and logged “Selector not found (WoWProgress ratingContainer) — site markup may have changed”. Nothing had changed; the page was not the site yet. The challenge is now recognised and sat out (the check shared with WarcraftLogs, which is behind the same thing), and a genuinely missing table is reported once after a grace period instead of immediately — so the warning still fires when it should, and only then.
- **Scout could never score anyone — every candidate showed “⚠ WCL err”** — The service worker's sender check required `sender.tab` to be absent for an extension page, but Chrome populates `sender.tab` for anything sent from a tab and the Scout page is opened in one, so every score request Scout made was refused as `UNTRUSTED_SENDER`. The check now trusts the sender's `chrome-extension://` URL and extension id, which is where the boundary actually is; the tab-bound actions were never protected by the tab check and are unchanged.
- **"Tabs cannot be edited right now" no longer fails a harvest** — Chrome refuses `tabs.create`/`tabs.remove` while the tab strip is busy, which Scout hit routinely because it opens and closes several background tabs in a row. Sources reported it as a harvest failure ("WarcraftLogs returned nothing: Tabs cannot be edited right now"), which named no fix and had nothing to do with recruitment. That one refusal is now retried; every other tabs error still fails immediately.
- **Raider.IO's Scout source harvested nothing** — Its advanced search now needs `type=character`; without it the table renders an empty `.rt-noData` body rather than an error, so Scout reported "No results rendered within 15s (selector `.rt-tr-group`)" and pointed at a markup change that had not happened. The parameter is now in the default listing URL, enforced on the page itself, and added to a saved URL that lacks it. Verified against the live listing: 104 rows, 100 candidates, nothing missing.
- **Raider.IO roles all read as unknown** — Raider.IO removed its role column (the last cell is now "Published") and with it the `.tank-lfg-rio` / `.healer-lfg-rio` / `.dps-lfg-rio` markers the row reader depended on. The role now comes from the spec icon on every row, which names the role outright — a better source than the markers it replaces. Live check: 100 of 100 rows resolved (72 DPS, 19 tank, 9 healer).
- **A failed WarcraftLogs lookup now explains itself** — Scoring fails open, so nobody was hidden, but the reason lived only in each badge's hover tooltip: a lookup failing for every candidate produced a table of identical "⚠ WCL err" badges and a banner that said nothing. Scout now groups scoring failures and reports each with the fix that applies — bad credentials and a broken token endpoint share a message prefix but not a remedy, and a GraphQL rejection is flagged as needing an extension fix rather than a settings change.
- **Raider.IO no longer reports "its content script never answered"** — Raider.IO rewrites its own query string to force the sort order, and the reload plus first render outlasted the old 3.5-second retry budget. Harvest retries now run against a 12-second wall-clock deadline, and a genuine give-up says how many attempts it made over how long instead of blaming the extension.

### Removed
- **WarcraftLogs is no longer a Scout source** — Scout harvested its recruitment page by opening it in a background tab, which was the least reliable part of a run: WarcraftLogs sits behind an aggressive Cloudflare configuration, so the source that most needed a tab was the one most likely to be served a security check instead of a listing. Their v2 API cannot stand in for it — the schema covers characters, guilds, reports, rankings and game data, and describes no recruitment post anywhere (the recruitment Discord integration is an outbound webhook, not a queryable endpoint). WarcraftLogs keeps the job only it can do: **every candidate is still ranked by WarcraftLogs parses**, unchanged. Scout now harvests WoWProgress, Raider.IO and Guilds of WoW; the recruitment page's own filters and inline badges are untouched for browsing it yourself. A stored source filter naming WarcraftLogs is dropped rather than left to match nothing.

---

## [1.4.0] — Unreleased

### Added
- **Documentation split into `docs/`** — The README had grown to 381 lines covering install, five feature areas, three full settings tables and eleven troubleshooting entries in one scroll. It is now a 160-line landing page — what RaidScout does, how to install it, a quick start and a map — with the long-form material in [`docs/scout.md`](docs/scout.md), [`docs/warcraftlogs-api.md`](docs/warcraftlogs-api.md), [`docs/settings.md`](docs/settings.md) and [`docs/troubleshooting.md`](docs/troubleshooting.md).
- **Screenshots** (`docs/screenshots/`) — The popup, the per-role threshold grid, a site's filter tab, the parse badge states and the Scout table. The badge legend is rendered from the extension's own `makeBadge()`, so it cannot drift from the code it documents.
- **Scout — cross-site recruitment aggregator** (`src/scout/`) — New full-page view opened from the popup's "🔎 Scout all sites" button. Harvests every configured recruitment site in one pass, merges the results into a single de-duplicated candidate list, scores each unique player once through the existing WarcraftLogs pipeline, and renders them in a sortable table with search, CSV export and an in-game whisper list. Two harvest modes behind one adapter registry (`sources.js`): `fetch` parses the listing directly (WoWProgress, the only server-rendered one), `tab` opens the listing in a background tab, lets the site's own content script filter it, harvests the visible rows via the new `registerHarvester()` hook, and closes the tab (Raider.IO, Guilds of WoW, WarcraftLogs recruitment).
- **Cross-source de-duplication** — A player advertising on several sites becomes one row marked `×N` and is scored once rather than once per site. Realm slugging (`slugRealm()`) collapses the three spellings the sites use (`Tarren Mill` / `tarren-mill` / `Tarren-Mill`) and apostrophe variants. Numeric stats merge by taking the higher value; class and role by source authority.
- **Scout settings tab** — Source selection, candidate cap (default 150, sized to the WCL API's hourly budget), WoWProgress page count, scoring toggle, threshold toggle, and per-source listing URL overrides.
- **`hasNoLogs()` / `isScored()`** (`scout-core.js`) — Classify a score result as a definitive answer about the player versus a failed request.
- **Support links** (`src/links.js`) — Unobtrusive "Support development" and "YouTube" links in the popup footer, the Scout page footer and Full Settings. Plain anchors opened in a new tab with `rel="noopener noreferrer"` — no ad network, no remote script, no tracking, no CSP or host-permission changes, so the extension still makes no network request of its own. URLs live in one constant and every surface reads from it.
- **78 new tests** — `tests/scout-core.test.js` imports `scout-core.js` directly (it is a real ES module, unlike the content scripts); `tests/sources.test.js` covers the WoWProgress HTML parser against jsdom fixtures.
- **Pre-flight scouting** — The scout flow now scores a candidate through the WarcraftLogs API *before* opening their character tab, and only opens one for candidates that pass your thresholds. Rejected candidates no longer have a tab opened and immediately closed again, so they never have to clear WarcraftLogs' Cloudflare check on the way to being discarded. Controlled by **Check parses before opening a tab** (`scoutPreflight`, default on) in the WarcraftLogs section and the popup. Requires API credentials; without them (or if a lookup fails for any reason) RaidScout falls back to the original open-then-check flow, so scouting never gets stricter because a lookup failed.
- **Open scouted tabs in the background** — New `scoutOpenInBackground` setting (default off) opens WarcraftLogs tabs without stealing focus.
- **Role auto-resolution (`role: 'auto'`)** — A single GraphQL request now fetches both the `dps` and `hps` rankings under aliases and picks the right one from the spec WarcraftLogs ranked the character as. This is what makes pre-flight possible without a page to read a spec icon from, and it replaces the guesswork on the two pages where role markup was unreliable: WoWProgress rows and the WCL recruitment search. Sites with dependable role markup (Raider.IO, Guilds of WoW) still send the role they read and skip the extra metric.
- **Cloudflare-aware API client** — A challenged request (403/503 with Cloudflare headers or an interstitial body) is now reported as `CLOUDFLARE_BLOCKED` with its own 5-minute backoff instead of a generic HTTP error. The popup and Full Settings show a countdown explaining that loading warcraftlogs.com in a tab clears it, rows get a `☁ CF check` badge, and the backoff is dropped the moment a real WarcraftLogs page renders (`wclPageReady`).
- **Skip visibility** — With no tab flashing open and shut there is nothing to see when a candidate is filtered, so Raider.IO shows a transient "skipped WarcraftLogs" notice on the character page and the popup shows the most recent skip (`getLastScoutSkip`).
- **`src/preflight.js`** — Pure decision module (spec→role map, role-aware thresholds, verdict, WCL character URL parsing) shared by the service worker and covered directly by `tests/preflight.test.js` rather than through inlined copies. Named for the flow rather than the feature, so it is not mistaken for `src/scout/`, the unrelated aggregator page added in the same release.

### Changed
- **Options page is no longer a 400px column** — The container was pinned to a fixed 400px even though the page opens as a full browser tab, so 51 settings stacked into an endless scroll and the tab labels ellipsised ("WoWProgr…", "Guilds of W…"). It now grows to a readable width and lays settings out in two columns on wide viewports. `showCategory()` toggles an `.is-active` class instead of an inline `display`, since an inline style would override the grid.
- **Parse thresholds are a role grid** — Six stacked inputs, each with its own hint paragraph, became a 3x2 grid (DPS / Tank / Healer against Best / Median) with role colour bars. The tank-falls-back-to-DPS relationship is visible rather than described.
- **Advanced settings are collapsed** — Cache TTL, clear-cache, debug logging and request concurrency on the WarcraftLogs tab, and the four per-source listing URLs on the Scout tab, now sit behind disclosure panels.
- **Design tokens** (`src/shared.css`) — The palette was ~90 loose hex literals across three stylesheets, with the 13 WoW class colours duplicated verbatim in two of them. They are now CSS custom properties loaded by all three surfaces; each keeps its own selectors but reads one value.
- **Scout table** — Zebra striping and a stronger hover tint for scanning eleven columns, and class names render properly ("Death Knight", not "deathknight").
- **Characters with no WarcraftLogs logs now fail every parse threshold** — `failsWclThresholds()` returns `true` for a definitive no-logs result (`notFound`, or a successful lookup with both metrics null) on every site and in Scout. A character with no parses cannot be judged against a parse minimum. Lookups that *failed* (no credentials, rate limit, timeout) and candidates that were never scored are still always kept, so a misconfiguration can never empty a page.
- **`isTrustedSender` split** (`background.js`) — Now `isTrustedTabSender` (host allowlist; the only path that can trigger the tab-bound `parseThresholdFailed`/`openTab`/`clearBadge` actions) and `isExtensionPageSender` (extension origin, no tab). The Scout page has no `sender.tab` and was rejected outright before this.
- **The WCL character-page content script no longer needs the page.** Scores come from the API, so it asks immediately instead of polling for a spec icon, detects the Cloudflare interstitial and neither burns its attempt budget nor closes a tab mid-challenge, and applies the same role-aware thresholds the rest of the extension uses (it previously compared everyone against the DPS pair).
- **Badge counter counts skipped candidates**, from both pre-flight skips and the older open-then-close path. Popup label changed from "closed" to "skipped".
- `getApiStatus` replaces `getRateLimitStatus` — one status covering both rate-limit and Cloudflare backoff, used by the popup and Full Settings.
- `badgeStateForScore()` in `common.js` replaces the four copies of the same badge-state ladder in the site scripts; `effectiveRole()` prefers the API-resolved role over whatever the page markup suggested.

### Fixed
- **Licensing was ambiguous** — README advertised MIT, `package.json` declared ISC, and no `LICENSE` file existed, so nothing was definite. Now MIT throughout, with a proper `LICENSE` file and a copyright line. README's licence section also now carries the standard unaffiliated-fan-project disclaimer for Blizzard and the four recruitment sites.
- **WoWProgress realms with spaces were never scored** — `getWowProgressCharacter()` slugged the percent-encoded href segment without decoding it, sending `tarren%20mill` to the WarcraftLogs API and getting `notFound` back for every multi-word realm. Proactive scoring on WoWProgress had been silently failing for those characters.
- **Per-site enable toggles now actually grey out their section.** `options.css` has carried a `.section-disabled` rule since the settings page was written, but nothing ever applied the class — turning a site off left its settings looking and behaving exactly as before, with no sign they were inert. `options.js` now toggles the class and disables the section's controls on load and on every toggle change. The section header keeps its enable switch interactive, disabled inputs keep their values (so Save is unaffected), and the greying now also covers the bare subsection labels and hints between option blocks.
- **Rate-limit cooldown reported 1000× too long.** The cached-cooldown path threw `RATE_LIMITED:<ms>` while the 429 path threw `RATE_LIMITED:<seconds>`, and the consumer multiplied both by 1000 — a 60-second cooldown surfaced as a 16-hour one in the badge and status bar. Both paths now report seconds.

### Removed
- **`.mailmap`** — It canonicalised the author name by mapping a personal email address, which meant publishing that address in a tracked file. Removed, and purged from history along with the author and committer addresses on every commit, which are now `MChambers1992@users.noreply.github.com`. Every commit hash changed as a result; clones from before the rewrite need a fresh `git clone`.
- **Three per-site sort toggles became one** — `wpWclSort`, `rioWclSort` and `gowWclSort` were the same preference stored three times, needing nine UI controls across the popup and options page for one concept. Replaced by the shared `wclSortByParse`. `wclSortEnabled()` in `common.js` falls back to any of the three old keys when the shared one is absent, so existing installs keep the behaviour they chose without re-configuring.
- **`wclHideUnknown` setting** — Superseded by the unconditional no-logs rule above. Made unconditional rather than default-flipped because most existing installs have an explicit `false` saved, which a default change would never have reached.

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
