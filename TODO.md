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

### Verify Cloudflare challenge detection against a live challenge (low effort, high value)

`isCloudflareChallenge()` in `wcl-api.js` and `isCloudflareChallengePage()` in
`content/warcraftlogs.js` were written from Cloudflare's documented challenge
markers (`cf-mitigated`, `cf-ray` + HTML, `#challenge-running`, the
`challenge-platform` script, "Just a moment" titles) rather than against a live
challenge, which is hard to provoke on demand. Both fail safe if they miss — an
undetected challenge just surfaces as a generic API error or wastes a couple of
poll attempts — but confirming the markers against a real interstitial (a VPN exit
node or a fresh profile is usually enough to trigger one) would close the loop.

### Automated selector smoke test (medium effort, medium value)

`assertSelector()` in `common.js` logs warnings when a selector finds nothing. A
Playwright test suite that loads each target site in a headless browser and verifies
no warnings fire would catch site-markup changes before users report them.

The main challenge is authentication — WoWProgress and Raider.IO lists require no
login, but WCL recruitment search requires a WoW account. A CI-safe approach would
be to test only the pages that don't need auth, and rely on `assertSelector` warnings
for the rest.

The role-detection selectors this was also meant to validate (`getRecruitmentRole` in
`warcraftlogs.js`, `getPlayerRole` in `wowprogress.js`) matter less since v1.4: both
now return `null` when the markup doesn't say and the API resolves the role from the
character's ranked spec instead. A smoke test would still confirm whether the DOM
path ever fires — if it never does on the live site, the selectors can be deleted and
those two sites can always use `role: 'auto'`.

### Localization / i18n (low priority)

All user-visible strings are hardcoded in English. Chrome extensions support
`_locales/<lang>/messages.json` via `chrome.i18n.getMessage`. Low priority given
the WoW recruitment community is predominantly English-speaking, but required for
a Chrome Web Store "Featured" badge.

Surfaces to translate: popup labels, options page labels and hints, inline badge
text (the `⏳ WCL` / `📋 No logs` labels), filter summary bar text.
