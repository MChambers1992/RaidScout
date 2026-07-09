# RaidScout — TODO & Future Improvements

Items deferred from the v1.3 improvement pass.

---

## Deferred from previous passes (completed or superseded)

- ✅ Build step — assessed: not needed. The globals-via-injection-order pattern is reliable in MV3 and the maintainability problem it was meant to solve is now addressed by `settings-schema.js`.
- ✅ Per-role WCL thresholds — implemented in v1.3.
- ✅ Sort by WCL parse — deferred, see below.
- ✅ WarcraftLogs reactive flow → API — implemented in v1.3.
- ✅ Configurable concurrency — implemented in v1.3.
- ✅ Export/import includes local settings — implemented in v1.3 (v2 format).
- ✅ CHANGELOG.md — added in v1.3.
- ✅ WCL recruitment search storage.onChanged for class filter — fixed in v1.3.
- ✅ Rate-limit UI in popup — added in v1.3.
- ✅ Explicit getClosedTabCount message — added in v1.3.
- ✅ Localization — deferred, see below.
- ✅ Automated selector smoke test — deferred, see below.
- ✅ WCL search/proactive overlap documentation — addressed in options UI hint text.

---

## Active backlog

### Sort by WCL parse (medium effort, high value)

The filter is binary (show/hide). A sort layer would let users rank by parse without
hiding anyone. Approach per site:

- **Raider.IO**: the React table exposes a column sort. After all scores arrive, store
  `dataset.wclBest` / `dataset.wclMedian` on each `.rt-tr-group`, then re-sort the DOM.
  Watch for observer re-fires re-scrambling the order.
- **WoWProgress / GoW**: simpler — collect all visible rows/cards after scoring,
  sort the array by score, then re-insert in sorted order using `appendChild`.
- Add a "Sort by WCL parse" checkbox in each site's WCL filter block. Default off so
  current behaviour is unchanged.

### Automated selector smoke test (medium effort, medium value)

`assertSelector()` in `common.js` logs warnings when a selector finds nothing. A
Playwright test suite that loads each target site in a headless browser and verifies
no warnings fire would catch site-markup changes before users report them.

The main challenge is authentication — WoWProgress and Raider.IO lists require no
login, but WCL recruitment search requires a WoW account. A CI-safe approach would
be to test only the pages that don't need auth, and rely on `assertSelector` warnings
for the rest.

### Localization / i18n (low priority)

All user-visible strings are hardcoded in English. Chrome extensions support
`_locales/<lang>/messages.json` via `chrome.i18n.getMessage`. Low priority given
the WoW recruitment community is predominantly English-speaking, but required for
a Chrome Web Store "Featured" badge.

Surfaces to translate: popup labels, options page labels and hints, inline badge
text (the `⏳ WCL` / `📋 No logs` labels), filter summary bar text.

### WarcraftLogs recruitment search — proactive scoring overlap

`warcraftlogs.js` filters the WCL-hosted recruitment search page (`/recruitment/`)
using the `wclSearchParseThreshold` key. The proactive scoring system operates on
WoWProgress, Raider.IO, and GoW. They are on different pages and don't conflict,
but a user might expect similar behaviour on both. The WCL recruitment search page
could also use the API-based proactive flow (it has character links) — this would
unify the two approaches.

### Rate-limit UI auto-refresh

The rate-limit banner in both popup and Full Settings is shown once on open and does
not count down. Add a `setInterval` that updates the remaining-seconds display every
second and hides the banner when it reaches zero.

### Tab count badge in popup — auto-update

The closed-tab count shown in the popup is fetched once on open. If tabs are closed
while the popup is open it won't update. Add a `chrome.runtime.onMessage` listener
in the popup to receive a `badgeUpdated` notification and refresh the count.
