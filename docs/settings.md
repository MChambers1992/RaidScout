# Settings reference

[← Back to README](../README.md)

Every setting in **⚙ Full Settings**, by tab. Blank defaults (`—`) mean the
filter is off — a zero minimum excludes nobody.

All settings sync across Chrome devices via Chrome Sync, **except** the
WarcraftLogs Client Secret and the score cache, which are machine-local.

---

## WarcraftLogs tab

| Setting | Default | Description |
|---|---|---|
| Enabled | On | Enable/disable all WarcraftLogs features |
| Min. Best Parse % (DPS/Tank) | 60 | **Shared** — closes an auto-opened WCL tab and hides list candidates below this best DPS parse, on every site |
| Min. Median Parse % (DPS/Tank) | 50 | **Shared** — closes an auto-opened WCL tab and hides list candidates below this median DPS parse, on every site |
| Min. Best HPS % (Healer) | — | **Shared** — minimum best HPS parse for healers |
| Min. Median HPS % (Healer) | — | **Shared** — minimum median HPS parse for healers |
| Min. Best % (Tank override) | — | **Shared** — overrides the DPS best threshold for tanks only |
| Min. Median % (Tank override) | — | **Shared** — overrides the DPS median threshold for tanks only |
| Sort lists by parse | Off | **Shared** — ranks candidates by parse (highest first) on every site with proactive filtering on. Was three per-site toggles before 1.4.0; your existing choice carries over |
| Check parses before opening a tab | On | Scout via the API first and only open a WarcraftLogs tab for candidates who pass. Needs credentials; falls back to open-then-close without them |
| Open scouted tabs in the background | Off | Open WarcraftLogs tabs without switching to them |
| Recruitment search parse filter | — | Minimum parse % on the WarcraftLogs recruitment search page |
| Use role-aware API scoring (search) | Off | Also apply the full proactive scoring flow to recruitment search results, on top of the flat minimum above. Requires credentials |
| Min mythic kills (WCL search) | — | Minimum current-tier mythic kill count on the recruitment search page |
| Region / Class filter (WCL search) | All | Narrow recruitment search results. Leave unchecked to show all |
| Client ID | — | WarcraftLogs v2 API client ID (synced across devices) |
| Client Secret | — | WarcraftLogs v2 API client secret (local only, never synced) |
| Score cache TTL | 6h | How long to cache a character's parse score before re-fetching |
| Max concurrent lookups | 4 | Simultaneous WCL API requests when scoring a list page (1–8) |
| Debug logging | Off | Logs API queries and scores to the service worker console |

## WoWProgress tab

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

## Raider.IO tab

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

## Guilds of WoW tab

| Setting | Default | Description |
|---|---|---|
| Enabled | On | Enable/disable all Guilds of WoW features |
| Min Item Level | — | Hide recruit cards below this item level |
| Min Mythic Kills | — | Hide recruits below this current-tier mythic kill count |
| Min M+ Score | — | Hide recruits below this M+ score |
| Class Filter | All | Show only selected classes (uncheck all for any) |
| Role Filter | All | Show only Tank / Healer / DPS cards (uncheck all for any) |
| Enable proactive WCL filtering | Off | Look up parse scores and hide below-threshold cards. Thresholds are set once in the **WarcraftLogs** tab |

## Scout tab

| Setting | Default | What it does |
|---|---|---|
| Sources | all three | Which recruitment sites a Scout run harvests |
| Max candidates per run | 150 | Cap on unique candidates scored — each one is a WarcraftLogs API call |
| WoWProgress pages per run | 1 | How many pages of the WoWProgress listing to pull |
| Fetch WarcraftLogs parses | On | Score candidates via the API. Off = list only, no parses |
| Hide candidates below thresholds | On | Apply your parse thresholds to the results, and hide candidates with no logs. Candidates that couldn't be scored stay visible (also toggleable on the Scout page) |
| Cross-reference stats with Raider.IO | On | Look every candidate up on Raider.IO's public character API to fill in M+ score, mythic progress and item level. Each listing publishes a different subset, so without this those columns are blank because of where the recruit advertised rather than how they play. Needs no API key |
| Listing URLs | blank | Override the default listing URL per source. Blank = use the default |

---

## Popup vs. Full Settings

The popup shows the most-used settings per site and **auto-saves** 400ms after
you change anything — no Save button. Full Settings has everything and saves on
an explicit **Save** click.

The popup writes back every setting it read, including the ones it doesn't
display (class filters, API keys), so using it never clobbers a selection you
made in Full Settings.

For the underlying storage keys, defaults and types, see
[CLAUDE.md](../CLAUDE.md#settings-reference).
