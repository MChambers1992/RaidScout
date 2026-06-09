# RaidRecruiter Plus

A Chrome extension that streamlines World of Warcraft guild recruitment by extending functionality on WarcraftLogs, WoWProgress, and Raider.IO.

## Features

- **WarcraftLogs** — Automatically closes character tabs that fall below your configured DPS parse thresholds, saving time when evaluating applicants
- **WoWProgress** — Filters player listings by region and minimum item level directly in the table view
- **Raider.IO** — Converts character URLs to WarcraftLogs for quick cross-referencing; enforces search result sorting

## Installation

No build step required — the extension loads directly from source.

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (toggle in the top-right)
4. Click **Load unpacked** and select the `RaidRecruiter Plus` folder inside the repo

The extension icon will appear in your toolbar. Click it to open settings.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| Parse Threshold | 50 | Minimum median DPS parse % to keep a WarcraftLogs tab open |
| Best Parse Threshold | 60 | Minimum best DPS parse % to keep a WarcraftLogs tab open |
| Region | EU | Filter WoWProgress players by region (EU / US / OC) |
| Min Item Level | 635 | Hide WoWProgress players below this item level |
| Auto-open WarcraftLogs from WoWProgress | On | Opens WarcraftLogs tab when visiting a character page on WoWProgress |
| Auto-open WarcraftLogs from Raider.IO | On | Opens WarcraftLogs tab when visiting a character page on Raider.IO |

Settings sync across your Chrome devices via Chrome Sync.

## Releases

Packaged `.zip` files ready for Chrome are attached to each [GitHub Release](../../releases). To install a release build:

1. Download the `.zip` from the release page
2. Go to `chrome://extensions/` → enable Developer mode
3. Drag and drop the `.zip` onto the page

## Development

See [CLAUDE.md](RaidRecruiter%20Plus/CLAUDE.md) for full architecture notes, debugging tips, and a settings reference.

## License

MIT
