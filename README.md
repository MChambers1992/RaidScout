# RaidScout

A Chrome extension that streamlines World of Warcraft guild recruitment. Filters candidate lists on WoWProgress, Raider.IO, and Guilds of WoW by item level, class, role, and WarcraftLogs parse score — and auto-closes low-parse WarcraftLogs tabs as you review.

---

## Contents

- [Installation](#installation)
- [Quick start](#quick-start)
- [How filtering works](#how-filtering-works)
- [Site features](#site-features)
- [Proactive WarcraftLogs filtering setup](#proactive-warcraftlogs-filtering-setup)
- [Per-role parse thresholds](#per-role-parse-thresholds)
- [Settings reference](#settings-reference)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

---

## Installation

No build step required — the extension loads directly from source.

1. Clone or [download this repository](../../archive/refs/heads/main.zip) and unzip it
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked** and select the repository root folder

The RaidScout icon will appear in your toolbar. Pin it for easy access.

To install from a packaged release instead, download the `.zip` from the [Releases page](../../releases), then drag and drop it onto `chrome://extensions/`.

---

## Quick start

**Basic filtering (no API key needed):**

1. Install the extension and pin it to your toolbar
2. Click the icon to open the popup — it auto-detects which site you're on
3. Set your filters (item level, class, role) and they apply immediately
4. Visit a character page on WoWProgress or Raider.IO and a WarcraftLogs tab opens automatically
5. If their parse is below your threshold in Full Settings, that tab closes itself

**Proactive parse filtering (requires a free WarcraftLogs API key):**

1. Follow the [WarcraftLogs API setup](#proactive-warcraftlogs-filtering-setup) below
2. Enable "Proactive WCL filtering" on each site in Full Settings
3. Set your parse thresholds — candidates below them are hidden before you ever click

---

## How filtering works

RaidScout has two complementary filtering modes that work independently and can both be active at the same time.

### Reactive filtering

When you visit a character page on WoWProgress or Raider.IO, RaidScout opens their WarcraftLogs page in a new tab. It then checks their parse scores — if they fall below your configured median or best parse thresholds, the tab closes automatically. The extension icon badge counts how many tabs have been closed in the current session.

This works with no API key and no extra setup. It just adds automation to what you'd do manually.

### Proactive filtering

With a WarcraftLogs API client configured, RaidScout looks up parse scores *before you click*, directly on the recruitment list pages. Characters below your thresholds are hidden (with a count showing how many were filtered), and every visible candidate gets a small inline badge showing their Best / Median parse percentage.

Role is detected automatically — healers are scored on HPS, DPS and tanks on DPS — so you can set separate thresholds for each role.

Proactive filtering requires a one-time setup described below.

---

## Site features

### WarcraftLogs

- **Reactive tab close** — Opens a character's WarcraftLogs page when you visit them on WoWProgress or Raider.IO, then auto-closes it if their parse falls below your thresholds
- **Closed-tab badge** — The extension icon badge counts tabs auto-closed this session; resets when you click the badge area in the popup
- **Recruitment search filter** — On the WarcraftLogs recruitment search page (`/recruitment/`), filters candidates by parse score, region, class, and mythic kill count

### WoWProgress

- **Player list filtering** — Filters the lfg table by region, item level (min and max), class, and guild status
- **Auto-open WarcraftLogs** — Opens a WarcraftLogs tab when you visit any character page
- **Proactive parse filtering** — Hides below-threshold candidates directly in the table and shows inline parse badges (requires API setup)

### Raider.IO

- **Guild recruitment search filtering** — Filters search results by item level, region, role, and class
- **Sort enforcement** — Ensures results are always sorted by most recently published
- **Ad removal** — Hides ad containers via injected CSS
- **Auto-open WarcraftLogs** — Opens a WarcraftLogs tab when visiting a character page
- **Proactive parse filtering** — Hides below-threshold rows and shows inline parse badges (requires API setup)

### Guilds of WoW

- **Recruits list filtering** — Filters recruit cards by item level, current-tier mythic kill count, M+ score, class, and role
- **Proactive parse filtering** — Hides below-threshold cards and shows inline parse badges (requires API setup)

---

## Proactive WarcraftLogs filtering setup

This feature uses the official WarcraftLogs v2 API. The API is free; you just need to create a client.

### Step 1 — Create a WarcraftLogs API client

1. Sign in at [warcraftlogs.com](https://www.warcraftlogs.com/)
2. Click your username → **Settings**
3. Scroll to **API clients (v2)** and click **Manage your API clients**
4. Click **Create client**
5. Give it any name (e.g. "RaidScout")
6. Set any redirect URL — `https://localhost` works fine; RaidScout never redirects
7. Click **Save** and copy the **Client ID** and **Client Secret** that appear

### Step 2 — Enter credentials in RaidScout

1. Click the RaidScout icon → **⚙ Full Settings**
2. Go to the **WarcraftLogs** tab
3. Paste your **Client ID** and **Client Secret** into the API Credentials fields
4. Click **Test connection** — you should see "✓ Connected successfully"
5. Click **Save**

The Client ID syncs across your Chrome devices. The Client Secret is stored locally only and is never synced.

### Step 3 — Set your thresholds once, then enable per site

Parse thresholds are configured a single time in the **WarcraftLogs** tab and apply everywhere. In Full Settings:

1. On the **WarcraftLogs** tab, under **Proactive Score Filter**, set **Min. Best Parse %** and/or **Min. Median Parse %** for DPS characters
2. Optionally set separate thresholds for healers and tanks (see [Per-role parse thresholds](#per-role-parse-thresholds))
3. Decide whether to **Hide characters with no logs** (off by default — unlogged characters stay visible)
4. On each site's tab (WoWProgress, Raider.IO, Guilds of WoW), toggle on **Enable proactive WCL filtering**
5. Click **Save**

The same DPS thresholds also drive the WarcraftLogs tab auto-close. Thresholds take effect immediately on any open list pages, no refresh needed.

### How it behaves

- **Parse badges** appear on every candidate showing their Best / Median parse %
  - Green = above threshold
  - Amber = within 10% of threshold (warning zone)
  - Red = below threshold (hidden, unless you've revealed them)
  - "📋 No logs" = character has no WarcraftLogs data
  - "⚠ WCL err" = lookup failed (character stays visible — filtering always fails open)
  - "🚦 Rate limited" = the API is throttled; try again shortly
- A **filter summary bar** above the list shows how many candidates were hidden
- Scores are **cached for 6 hours** per character to stay within API rate limits. Use **Clear cached scores** in the WarcraftLogs tab to force fresh lookups
- If credentials are missing or a lookup fails, **nobody is hidden** — the feature always fails open rather than wrongly filtering candidates

---

## Per-role parse thresholds

Healer HPS parses and DPS parses aren't directly comparable numbers, so RaidScout lets you set separate thresholds per role. In Full Settings on each site's WCL filter section you'll find three threshold groups:

**DPS & Tank** — applies to DPS characters. Tanks use the DPS metric by default but can be overridden with the Tank-specific fields below.

**Healer (HPS metric)** — applies to healers only. These thresholds are evaluated against the character's HPS parse percentage, not their DPS parse.

**Tank-specific (optional override)** — if set, overrides the DPS thresholds for tank characters only. Leave blank to use the DPS thresholds for tanks.

Role is detected automatically from each candidate row. On Raider.IO it reads the role icon; on Guilds of WoW it reads the role icon on the recruit card; on WoWProgress it infers from the spec icon. If role can't be determined, the DPS thresholds are used.

---

## Settings reference

### WarcraftLogs tab

| Setting | Default | Description |
|---|---|---|
| Enabled | On | Enable/disable all WarcraftLogs features |
| Min. Best Parse % (DPS/Tank) | 60 | **Shared** — closes an auto-opened WCL tab and hides list candidates below this best DPS parse, on every site |
| Min. Median Parse % (DPS/Tank) | 50 | **Shared** — closes an auto-opened WCL tab and hides list candidates below this median DPS parse, on every site |
| Min. Best HPS % (Healer) | — | **Shared** — minimum best HPS parse for healers (proactive scoring) |
| Min. Median HPS % (Healer) | — | **Shared** — minimum median HPS parse for healers (proactive scoring) |
| Min. Best % (Tank override) | — | **Shared** — overrides the DPS best threshold for tanks only |
| Min. Median % (Tank override) | — | **Shared** — overrides the DPS median threshold for tanks only |
| Hide characters with no logs | Off | **Shared** — also hide characters WarcraftLogs has no parse data for |
| Recruitment search parse filter | — | Minimum parse % on the WarcraftLogs recruitment search page |
| Min mythic kills (WCL search) | — | Minimum current-tier mythic kill count on the WCL recruitment search page |
| Client ID | — | WarcraftLogs v2 API client ID (synced across devices) |
| Client Secret | — | WarcraftLogs v2 API client secret (local only, never synced) |
| Score cache TTL | 6h | How long to cache a character's parse score before re-fetching |
| Max concurrent lookups | 4 | Simultaneous WCL API requests when scoring a list page (1–8) |
| Debug logging | Off | Logs API queries and scores to the service worker console |

### WoWProgress tab

| Setting | Default | Description |
|---|---|---|
| Enabled | On | Enable/disable all WoWProgress features |
| Auto-open WarcraftLogs | On | Open a WarcraftLogs tab when visiting a character page |
| Region | EU | Show only players from selected regions (uncheck all for any) |
| Min Item Level | — | Hide players below this item level |
| Max Item Level | — | Hide players above this item level |
| Guild Status | Any | Filter by in a guild / not in a guild / any |
| Class Filter | All | Show only selected classes (uncheck all for any) |
| Enable proactive WCL filtering | Off | Look up parse scores and hide below-threshold players. Thresholds are set once in the **WarcraftLogs** tab |

### Raider.IO tab

| Setting | Default | Description |
|---|---|---|
| Enabled | On | Enable/disable all Raider.IO features |
| Auto-open WarcraftLogs | On | Open a WarcraftLogs tab when visiting a character page |
| Remove Ads | On | Hide ad containers on Raider.IO pages |
| Min Item Level | — | Hide search rows below this item level |
| Region Filter | All | Show only selected regions (uncheck all for any) |
| Role Filter | All | Show only Tank / Healer / DPS rows (uncheck all for any) |
| Class Filter | All | Show only selected classes (uncheck all for any) |
| Enable proactive WCL filtering | Off | Look up parse scores and hide below-threshold rows. Thresholds are set once in the **WarcraftLogs** tab |

### Guilds of WoW tab

| Setting | Default | Description |
|---|---|---|
| Enabled | On | Enable/disable all Guilds of WoW features |
| Min Item Level | — | Hide recruit cards below this item level |
| Min Mythic Kills | — | Hide recruits below this current-tier mythic kill count |
| Min M+ Score | — | Hide recruits below this M+ score |
| Class Filter | All | Show only selected classes (uncheck all for any) |
| Role Filter | All | Show only Tank / Healer / DPS cards (uncheck all for any) |
| Enable proactive WCL filtering | Off | Look up parse scores and hide below-threshold cards. Thresholds are set once in the **WarcraftLogs** tab |

All settings sync across Chrome devices via Chrome Sync, except the WarcraftLogs Client Secret and score cache (which are machine-local).

---

## Troubleshooting

**Proactive filtering isn't hiding anyone**
- Check that "Enable proactive WCL filtering" is toggled on for the relevant site in Full Settings
- Click **Test connection** in the WarcraftLogs tab to confirm your credentials work
- Check that you've set at least one threshold value (Min Best % or Min Median %) — all zeros means no filtering
- If the popup or Full Settings shows "🚦 WCL rate limited", wait for the cooldown to expire or click **Clear cached scores**

**Parse badges show "⚠ WCL err"**
- This is a transient lookup failure — the character stays visible (filtering always fails open)
- If it persists across page refreshes, check the service worker console: in `chrome://extensions/` find RaidScout and click **Service worker** → **inspect**. Look for `[RaidScout WCL]` log lines (enable debug logging in Full Settings to see more detail)

**The filter cleared everyone / the list is empty**
- Check "Hide characters with no logs" — if this is on and most candidates have no WarcraftLogs data, they'll all be hidden
- Lower your parse thresholds or turn off "Hide characters with no logs"
- Refresh the page — some site SPAs can end up with stale filter state

**Auto-open WarcraftLogs isn't working on WoWProgress**
- Make sure you're on a character page, not a realm listing page
- Confirm "Auto-open WarcraftLogs" is on in Full Settings → WoWProgress
- Check that the WoWProgress site toggle is enabled

**Settings changed but the page didn't update**
- WCL filter settings propagate live without a page refresh
- Standard filters (item level, class, region) require a page reload on WoWProgress; Raider.IO and Guilds of WoW react live

**I want to reset everything**
- In Full Settings, use **Export Settings** to back up your current settings, then clear storage via `chrome://extensions/` → RaidScout → **Details** → **Extension options** → clear site data

---

## Development

No build step required. Edit source files and click the reload button on `chrome://extensions/` to pick up changes.

**Run tests:**
```
npm install
npm test
```

The test suite (Vitest, `tests/common.test.js`) covers the core filtering and scoring logic with 50 cases.

See [CLAUDE.md](CLAUDE.md) for full architecture notes, the complete settings key reference, debugging workflows, and known quirks. See [CHANGELOG.md](CHANGELOG.md) for version history.

---

## License

MIT
