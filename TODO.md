# RaidScout — TODO & Future Improvements

Items deferred from the v1.3 improvement pass.

---

## Deferred from previous passes (completed or superseded)

- ✅ Build step — assessed: not needed. The globals-via-injection-order pattern is reliable in MV3 and the maintainability problem it was meant to solve is now addressed by `settings-schema.js`.
- ✅ Per-role WCL thresholds — implemented in v1.3.
- ✅ WarcraftLogs reactive flow → API — implemented in v1.3.
- ✅ Configurable concurrency — implemented in v1.3.
- ✅ Export/import includes local settings — implemented in v1.3 (v2 format).
- ✅ CHANGELOG.md — added in v1.3.
- ✅ WCL recruitment search storage.onChanged for class filter — fixed in v1.3.
- ✅ Rate-limit UI in popup — added in v1.3.
- ✅ Explicit getClosedTabCount message — added in v1.3.
- ✅ WCL search/proactive overlap documentation — addressed in options UI hint text.
- ✅ Sort by WCL parse — implemented. `sortByWclScore()` in `common.js` re-orders visible
  rows/cards by median (falling back to best) parse after each scoring pass, gated behind
  a per-site "Sort by WCL parse" checkbox (`wpWclSort`/`rioWclSort`/`gowWclSort`, default
  off) in both the popup and Full Settings.
- ✅ WCL recruitment search — proactive scoring overlap — the recruitment search page can
  now opt into the same `requestWclScore`/`failsWclThresholds`/badge flow as the other
  three sites via the "Use role-aware API scoring" toggle (`wclSearchProactive`, default
  off), layered on top of the original flat `wclSearchParseThreshold` DOM-scrape filter
  which still works without API credentials. Role detection on this page is best-effort
  (see the note under "Automated selector smoke test" below) since the search-result
  markup for spec/role wasn't confirmed against the live site.
- ✅ Rate-limit UI auto-refresh — the rate-limit banner in the popup and Full Settings now
  counts down live via `setInterval` and hides/clears at zero.
- ✅ Tab count badge in popup auto-update — background now broadcasts `badgeUpdated` on
  every count change; the popup listens and refreshes live while open.

---

## Active backlog

### Automated selector smoke test (medium effort, medium value)

`assertSelector()` in `common.js` logs warnings when a selector finds nothing. A
Playwright test suite that loads each target site in a headless browser and verifies
no warnings fire would catch site-markup changes before users report them.

The main challenge is authentication — WoWProgress and Raider.IO lists require no
login, but WCL recruitment search requires a WoW account. A CI-safe approach would
be to test only the pages that don't need auth, and rely on `assertSelector` warnings
for the rest.

This would also validate the role-detection selectors added for the WCL recruitment
search's proactive scoring layer (`getRecruitmentRole` in `warcraftlogs.js`), which
were written defensively (`[class*="spec"], [class*="role"]`, defaulting to `'dps'`)
without a live page to confirm against — a smoke test with an authenticated session
is the most reliable way to verify or correct them.

### Localization / i18n (low priority)

All user-visible strings are hardcoded in English. Chrome extensions support
`_locales/<lang>/messages.json` via `chrome.i18n.getMessage`. Low priority given
the WoW recruitment community is predominantly English-speaking, but required for
a Chrome Web Store "Featured" badge.

Surfaces to translate: popup labels, options page labels and hints, inline badge
text (the `⏳ WCL` / `📋 No logs` labels), filter summary bar text.
