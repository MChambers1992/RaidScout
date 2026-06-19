# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**RaidScout** is a Chrome extension designed to streamline World of Warcraft guild recruitment. It extends functionality across multiple recruitment-related websites: WarcraftLogs, WoWProgress, Raider.IO, and Guilds of WoW.

**Author:** Michael Chambers  
**Current Version:** 1.0  
**Type:** Chrome Extension (Manifest V3)

## Tech Stack

- **Runtime:** Chrome Browser (Manifest V3)
- **Languages:** JavaScript (ES6+)
- **Build System:** None (direct file inclusion via manifest)
- **Storage:** Chrome Storage API (sync storage)

## Architecture

### Core Components

1. **Background Service Worker** (`src/background.js`)
   - Handles inter-tab communication via `chrome.runtime.onMessage`
   - Listens for page navigation events via `chrome.webNavigation.onCompleted`
   - Manages automatic tab opening/closing logic (WoWProgress → WarcraftLogs)
   - Maintains in-memory `closedTabCount` for the badge; resets on `clearBadge` message
   - Responds to: `parseThresholdFailed`, `openTab`, `clearBadge`

2. **Content Scripts** (injected per site via manifest `matches`)
   - **`src/content/common.js`** — Shared utilities injected before every other content script: `sendMessageToBackground(action, data)`, `normalizeClassName(name)`, and the `WOW_CLASS_NAMES` constant
   - **`src/content/warcraftlogs.js`** — Polls every 1s for DPS parse metrics; closes tab if below thresholds; 30s timeout cap
   - **`src/content/wowprogress.js`** — Filters player table rows by region, item level range, class, and guild status; uses MutationObserver + 2s polling
   - **`src/content/raiderio.js`** — Converts character URLs to WarcraftLogs; enforces search sorting/published-date params; hides ads via injected `<style>`
   - **`src/content/guildsofwow.js`** — Filters `.card` elements on the recruits list by item level, mythic kills, M+ score, class, and role; uses MutationObserver for SPA pagination; body observer waits for `#recruits-list` to appear

3. **Popup** (`src/popup/`)
   - Shown when the user clicks the extension icon
   - Context-aware: auto-expands the panel matching the active tab's site
   - 4 collapsible accordion panels (one per site), each showing the most-used settings
   - **Auto-saves** any change 400ms after user input — no Save button
   - Displays the closed-tab badge count; offers a clear button
   - "⚙ Full Settings" button calls `chrome.runtime.openOptionsPage()`
   - Does **not** include class filter (too complex for popup — that's in Full Settings only)

4. **Full Settings Page** (`src/options/`)
   - Opened via right-click → Options or the popup's Full Settings button
   - Tab navigation (WarcraftLogs / WoWProgress / Raider.IO / Guilds of WoW)
   - Per-site enable toggle with disabled state: settings grey out and become non-interactive when a site is OFF
   - Saves on explicit button click; shows `✓ Settings saved` confirmation
   - Category selection persisted in `localStorage`

### Data Flow

1. User configures settings in popup (auto-saved) or full settings page (save button)
2. All settings written to `chrome.storage.sync`
3. Background service worker monitors navigation events independently
4. Content script loads on target site → reads settings from storage → applies filtering/monitoring
5. Content script sends messages back to background (`parseThresholdFailed`, `openTab`)
6. Background acts: closes tabs, opens new tabs, updates badge

### Key Design Patterns

- **Message schema:** All messages use `{ action: string, ...data }` — background dispatches on `message.action`
- **MutationObserver Pattern:** `wowprogress.js`, `raiderio.js`, and `guildsofwow.js` use MutationObserver to react to dynamic DOM changes
- **Periodic Polling + Observer:** `warcraftlogs.js` polls (1s interval, 30-attempt cap); `wowprogress.js` also polls every 2s as a fallback
- **`!== false` pattern for defaults:** `options.someEnabled !== false` treats both `undefined` (never saved) and `true` as enabled
- **Per-site enable guards:** Every content script reads its `*Enabled` flag before running
- **Auto-save in popup vs explicit save in options:** Popup changes take effect immediately; options page requires Save

## Build & Deployment

**No build system required.** Load directly from source:

1. Open Chrome → `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the repository root
4. The extension icon appears; click it to open the popup

Background service workers require a manual **Inspect → reload** after code changes. Content scripts and popup reload automatically.

## Testing & Debugging

**Content script logs:** Open DevTools (F12) on the target website → Console tab.

**Background service worker logs:**
1. Go to `chrome://extensions/`
2. Click the **Service Worker** link under RaidScout

**Testing each integration:**
- **WarcraftLogs:** Navigate to any `warcraftlogs.com/character/...` page; watch console for parse metric detection
- **WoWProgress:** Visit a `wowprogress.com/gearscore/<realm>` page with `?lfg=1`; check console for filtering logs
- **Raider.IO:** Visit a `raider.io/characters/...` page; also test search at `raider.io/search?...recruitment.guild_raids`
- **Guilds of WoW:** Visit `guildsofwow.com/recruits`; watch for cards hiding as filters apply

**Reset all settings:**
```javascript
chrome.storage.sync.clear(() => console.log('Settings cleared'));
```

## Settings Reference

All stored in `chrome.storage.sync`. Defaults shown are what the extension uses when a key is absent.

### WarcraftLogs

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `warcraftlogsEnabled` | boolean | `true` | Enable/disable all WarcraftLogs features |
| `parseThreshold` | number | `50` | Min median DPS parse % — tab auto-closes if below |
| `bestParseThreshold` | number | `60` | Min best single DPS parse % — tab auto-closes if below |
| `wclSearchParseThreshold` | number | `0` | Min parse % for recruitment search results (0 = no minimum) |
| `wclSelectedRegions` | string[] | `[]` | Filter recruitment search by region — empty shows all |
| `wclMinMythicKills` | number | `0` | Min mythic kills for recruitment search (0 = no minimum) |
| `wclSelectedClasses` | string[] | `[]` | Filter recruitment search by class — empty shows all |

### WoWProgress

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `wowprogressEnabled` | boolean | `true` | Enable/disable all WoWProgress features |
| `openWarcraftLogsTab` | boolean | `true` | Auto-open WarcraftLogs when visiting a character page |
| `selectedRegions` | string[] | `["EU"]` | Filter players by region — empty array shows all |
| `minIlvl` | number | `0` | Minimum item level (float; 0 = no minimum) |
| `maxIlvl` | number | `0` | Maximum item level (float; 0 = no maximum) |
| `guildFilter` | string | `"any"` | Guild status: `"any"` / `"in"` / `"out"` |
| `selectedClasses` | string[] | `[]` | Allowed classes — empty array shows all |

> **Migration note:** The old `region` (string) key is still read as a fallback when `selectedRegions` is absent.

### Raider.IO

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `raiderioEnabled` | boolean | `true` | Enable/disable all Raider.IO features |
| `openWarcraftLogsFromRaiderIO` | boolean | `true` | Auto-open WarcraftLogs when visiting a character page |
| `hideRaiderIoAds` | boolean | `true` | Inject CSS to hide ad containers |
| `rioMinIlvl` | number | `0` | Minimum item level on the recruitment search table (0 = no minimum) |
| `rioSelectedRegions` | string[] | `[]` | Filter search rows by region (`"EU"` / `"US"` / `"OC"` / `"KR"` / `"TW"`) — empty shows all |
| `rioSelectedRoles` | string[] | `[]` | Filter search rows by main role (`"tank"` / `"healer"` / `"dps"`) — empty shows all |
| `rioSelectedClasses` | string[] | `[]` | Filter search rows by class — empty shows all (Full Settings only; not in popup) |

### Guilds of WoW

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `guildsofwowEnabled` | boolean | `true` | Enable/disable all Guilds of WoW features |
| `gowMinIlvl` | number | `0` | Minimum item level (0 = no minimum) |
| `gowMinMythicKills` | number | `0` | Minimum current-tier mythic kills (0 = no minimum) |
| `gowMinMythicPlusScore` | number | `0` | Minimum M+ score (0 = no minimum) |
| `gowSelectedClasses` | string[] | `[]` | Allowed classes — empty array shows all |
| `gowSelectedRoles` | string[] | `[]` | Allowed roles (`"tank"` / `"healer"` / `"dps"`) — empty shows all |

### WoW class name format

Class names are stored in lowercase with underscores: `warrior`, `paladin`, `hunter`, `rogue`, `priest`, `shaman`, `mage`, `warlock`, `monk`, `druid`, `deathknight`, `demon_hunter`, `evoker`.

WoWProgress uses this exact format in its DOM classlist. Guilds of WoW uses `img` alt text (e.g. `"Demon Hunter"`) and Raider.IO uses the `title` attribute on class icon spans (e.g. `"Death Knight"`). All sites normalise via the shared `normalizeClassName()` in `common.js`.

## Known Quirks & Non-Obvious Behaviors

1. **WarcraftLogs 30-attempt cap:** The extension polls for parse metrics up to 30 times (30 seconds). If the page hasn't loaded by then, the tab stays open — it will never auto-close even if the player is below threshold.

2. **WoWProgress rows are removed (not hidden):** `filterPlayers()` calls `playerRow.remove()`. Once removed, rows don't come back on the same page load. This is intentional — WoWProgress is a server-rendered pagination model, not a SPA.

3. **Guilds of WoW cards are hidden (not removed):** `guildsofwow.js` sets `card.style.display = 'none'`. Cards can reappear if settings change or the observer re-fires. GoW is a SPA with infinite scroll, so removal would break pagination.

4. **`dataset.filtered` marker on WoWProgress:** Prevents the table from being filtered twice on the same page load. The 2s polling interval also calls `observeTableChanges()` but only when `table.dataset.filtered` is absent.

5. **Raider.IO URL Conversion:** Replaces spaces in realm names with hyphens when constructing the WarcraftLogs URL (required by WarcraftLogs URL format).

6. **Storage sync timing:** `chrome.storage.sync.get()` is async. On a fast machine the content script and the storage callback race — settings may be `undefined` on the very first run. The `!== false` pattern and `|| 0` / `|| []` defaults handle this gracefully.

7. **Popup auto-save scope:** The popup saves everything it touches to storage, including settings it doesn't display (class filters). It reads them from storage, leaves them unchanged, and writes them back on every save call. There is no risk of overwriting class filter selections via the popup.

## File Structure

```
RaidScout/
├── manifest.json              # Extension metadata, permissions, content script routes
├── CLAUDE.md                  # This file
├── README.md                  # User-facing documentation
├── img/
│   ├── logo-16.png
│   ├── logo-48.png
│   └── logo-128.png
└── src/
    ├── background.js          # Service worker — tab management, badge, message routing
    ├── popup/
    │   ├── popup.html         # Quick-access popup (extension button click)
    │   ├── popup.css
    │   └── popup.js           # Context-aware accordion, auto-save
    ├── options/
    │   ├── options.html       # Full settings page (all options)
    │   ├── options.css        # Dark theme, WoW class colours, per-site accents
    │   └── options.js         # Load/save logic, tab navigation, disabled-state wiring
    └── content/
        ├── common.js          # Shared utilities: messaging, class normalisation, constants
        ├── warcraftlogs.js    # Parse threshold monitoring + tab auto-close
        ├── wowprogress.js     # Player table filtering (region/ilvl/class/guild)
        ├── raiderio.js        # WarcraftLogs redirect, search sorting, ad hiding
        └── guildsofwow.js     # Recruit card filtering (ilvl/mythic/M+/class/role)
```
