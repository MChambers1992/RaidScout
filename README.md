# RaidRecruiter Plus

A Chrome extension that streamlines World of Warcraft guild recruitment by extending functionality across WarcraftLogs, WoWProgress, Raider.IO, and Guilds of WoW.

## Features

### WarcraftLogs
- **Auto-close underperforming tabs** — Set a median and best parse threshold; tabs close automatically if a character falls below either
- **Closed-tab counter** — Badge on the extension icon tracks how many tabs have been closed this session

### WoWProgress
- **Filter the player table** by region (EU / US / OC), item level range, class, and guild status
- **Auto-open WarcraftLogs** — Automatically opens the matching WarcraftLogs tab when you visit a character page

### Raider.IO
- **Auto-open WarcraftLogs** — Opens the matching WarcraftLogs tab when visiting a character page
- **Enforce search sorting** — Ensures guild recruitment search results are sorted by most recently published
- **Remove ads** — Hides ad containers via injected CSS

### Guilds of WoW
- **Filter the recruits list** by item level, current-tier mythic kill count, M+ score, class, and role (Tank / Healer / DPS)

---

## Installation

No build step required — the extension loads directly from source.

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (toggle in the top-right)
4. Click **Load unpacked** and select the repository root folder

The extension icon will appear in your toolbar.

---

## Usage

**Click the extension icon** to open the quick-access popup. It detects which supported site you're currently on and automatically expands the relevant settings panel. Changes save instantly — no Save button needed.

**Right-click the icon → Options** (or use the **⚙ Full Settings** button in the popup) to open the full settings page with all options including class filters.

Each site can be enabled or disabled independently via its toggle. When a site is disabled, its settings are greyed out and the content script skips all processing on that site.

---

## Settings Reference

### WarcraftLogs

| Setting | Default | Description |
|---------|---------|-------------|
| Enabled | On | Enable/disable all WarcraftLogs features |
| Median Parse Threshold | 50 | Close tab if median DPS parse % is below this |
| Best Parse Threshold | 60 | Close tab if best single DPS parse % is below this |

### WoWProgress

| Setting | Default | Description |
|---------|---------|-------------|
| Enabled | On | Enable/disable all WoWProgress features |
| Auto-open WarcraftLogs | On | Open WarcraftLogs when visiting a character page |
| Region | EU | Show only players from selected regions (leave all unchecked for any) |
| Item Level | — | Min and/or max item level range (leave blank for no limit) |
| Guild Status | Any | Filter by in a guild / not in a guild / any |
| Class Filter | All | Show only selected classes (leave all unchecked for any) |

### Raider.IO

| Setting | Default | Description |
|---------|---------|-------------|
| Enabled | On | Enable/disable all Raider.IO features |
| Auto-open WarcraftLogs | On | Open WarcraftLogs when visiting a character page |
| Remove Ads | On | Hide ad containers on Raider.IO pages |

### Guilds of WoW

| Setting | Default | Description |
|---------|---------|-------------|
| Enabled | On | Enable/disable all Guilds of WoW features |
| Min Item Level | — | Hide recruits below this item level |
| Min Mythic Kills | — | Hide recruits below this current-tier mythic kill count |
| Min M+ Score | — | Hide recruits below this M+ score |
| Role Filter | All | Show only Tank / Healer / DPS (leave all unchecked for any) |
| Class Filter | All | Show only selected classes (leave all unchecked for any) |

All settings sync across your Chrome devices via Chrome Sync.

---

## Releases

Packaged `.zip` files are attached to each [GitHub Release](../../releases). To install from a release:

1. Download the `.zip` from the release page
2. Go to `chrome://extensions/` → enable Developer mode
3. Drag and drop the `.zip` onto the page

---

## Development

See [CLAUDE.md](CLAUDE.md) for full architecture notes, the complete settings key reference, debugging workflows, and known quirks.

## License

MIT
