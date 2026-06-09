# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**RaidRecruiter Plus** is a Chrome extension designed to streamline World of Warcraft guild recruitment. It extends functionality across multiple recruitment-related websites including WarcraftLogs, WoWProgress, and Raider.IO.

**Author:** Michael Chambers  
**Current Version:** 1.0  
**Type:** Chrome Extension (Manifest V3)

## Tech Stack

- **Runtime:** Chrome Browser (Manifest V3)
- **Languages:** JavaScript (ES6+)
- **Build System:** None (direct file inclusion via manifest)
- **Storage:** Chrome Storage API (sync storage)
- **Module Pattern:** Export/import style (content scripts) + IIFE for background

## Architecture

The extension follows a multi-layered architecture pattern:

### Core Components

1. **Background Service Worker** (`src/background/background.js`)
   - Handles inter-tab communication via `chrome.runtime.onMessage`
   - Listens for page navigation events via `chrome.webNavigation.onCompleted`
   - Manages automatic tab opening/closing logic based on user settings
   - Bridges communication between content scripts and the extension

2. **Content Scripts** (injected into target websites)
   - **`content_common.js`:** Shared utility for sending messages to background
   - **`content_warcraftlogs.js`:** Monitors DPS parse metrics and auto-closes tabs based on threshold settings
   - **`content_wowprogress.js`:** Filters player listings by region and item level; handles table mutation observation
   - **`content_rio.js`:** Converts Raider.IO URLs to WarcraftLogs; enforces search result sorting

3. **Options/Settings UI** (`src/options/`)
   - HTML popup interface displayed when user clicks extension icon or opens options
   - Categorized settings: WarcraftLogs, WoWProgress, Raider.IO, Guilds of WoW
   - Settings persist via `chrome.storage.sync` (synchronized across user's Chrome devices)
   - Category selection state stored in localStorage

4. **Utility Module** (`src/utils/storage.js`)
   - Wrapper functions for `chrome.storage.sync` API
   - Exports: `getStorage()`, `setStorage()`

### Data Flow

1. User configures settings in Options UI → saved to `chrome.storage.sync`
2. Background service worker monitors page navigation events
3. When content script loads on target site, it fetches settings from storage
4. Content script performs filtering/monitoring and may send messages back to background
5. Background may close tabs or open new tabs based on content script requests

### Key Design Patterns

- **Event-Driven Communication:** Content scripts and background communicate via `chrome.runtime.sendMessage()`
- **MutationObserver Pattern:** `content_wowprogress.js` and `content_rio.js` use MutationObserver to detect dynamic DOM changes
- **Periodic Polling:** `content_warcraftlogs.js` runs 1-second interval checks for parse metrics
- **URL-Based Routing:** Different content scripts injected based on `matches` patterns in manifest
- **Storage-Driven Settings:** All feature flags and thresholds live in Chrome storage, not hardcoded

## Build & Deployment

**No build system required.** The extension loads directly from source:

1. Open Chrome → `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the repository root directory

### Loading for Development

In Chrome DevTools (Extension tab):
1. Visit chrome://extensions/
2. Enable "Developer mode" (top-right toggle)
3. Click "Load unpacked" and select the repository root
4. The extension will appear with ID, permissions, and refresh button

Chrome will watch for file changes and auto-reload when you modify scripts (except background service workers, which may need manual reload).

## Testing & Debugging

### Browser Console Logging

All content scripts and background service worker use `console.log()` extensively:

1. **Content Script Logs:** Open DevTools (F12) on target website → Console tab
2. **Background Service Worker Logs:** 
   - Go to `chrome://extensions/`
   - Click "Service Worker" link under RaidRecruiter Plus
   - Opens DevTools for background context

### Testing Workflows

- **WarcraftLogs filtering:** Navigate to `https://www.warcraftlogs.com/character/...` and monitor console for parse metric detection
- **WoWProgress filtering:** Visit `https://www.wowprogress.com/gearscore/...` realm pages and check console for region/ilvl filtering logs
- **Raider.IO features:** Visit `https://raider.io/characters/...` character pages and search pages to test URL conversion and sorting

### Settings Reset

Clear all extension settings via Chrome DevTools Console:
```javascript
chrome.storage.sync.clear(() => console.log('Settings cleared'));
```

## Settings Reference

Stored in `chrome.storage.sync`:

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `parseThreshold` | number | 50 | Min median DPS parse % to keep WarcraftLogs tab open |
| `bestParseThreshold` | number | 60 | Min best DPS parse % to keep WarcraftLogs tab open |
| `openWarcraftLogsTab` | boolean | true | Auto-open WarcraftLogs tab from WoWProgress character pages |
| `region` | string | "EU" | Filter WoWProgress players by region (EU/US/OC) |
| `minIlvl` | number | 635 | Minimum item level to show on WoWProgress |
| `openWarcraftLogsFromRaiderIO` | boolean | true | Auto-open WarcraftLogs from Raider.IO character pages |
| `hideRaiderIoAds` | boolean | true | Remove ads from Raider.IO pages |

## Known Quirks & Non-Obvious Behaviors

1. **WarcraftLogs Tab Auto-Closing:** The extension checks parse metrics every 1 second. If a user navigates before the page fully loads, metrics may not be detected. The tab will remain open.

2. **WoWProgress Filtering & Pagination:** Uses `MutationObserver` to detect table changes, but also polls every 2 seconds for complete page reloads. The `dataset.filtered` marker prevents duplicate filtering on the same table instance.

3. **Raider.IO URL Conversion:** Replaces spaces in realm names with hyphens when constructing WarcraftLogs URL (per WarcraftLogs URL format).

4. **Storage Sync Timing:** `chrome.storage.sync.get()` callbacks are async. Content scripts may run before settings are retrieved on first load (within ~500ms). Consider adding retry logic if settings appear undefined.

5. **No Validation:** User-provided thresholds and item levels are not validated. Invalid inputs (negative numbers, non-numeric) may cause silent failures in filtering logic.

6. **Cross-Site Scripting Scope:** Each content script only has access to the DOM of its target site. Cannot access data from other WoW recruitment sites unless explicitly passed via message.

## Future Extension Points

- **Guilds of WoW:** Settings UI includes placeholder for future integration
- **Ad Hiding:** `hideRaiderIoAds` setting exists but is not yet implemented in `content_rio.js`
- **Character Search:** No global search functionality across multiple sites; each site has its own filtering
- **Export Data:** No export of filtered recruitment lists or audit logs

## File Structure

```
RaidRecruiter Plus/
├── manifest.json          # Extension metadata and permissions
├── src/
│   ├── background/
│   │   └── background.js  # Service worker for inter-tab communication
│   ├── content-scripts/
│   │   ├── content_common.js        # Message utility
│   │   ├── content_warcraftlogs.js  # Parse metric monitoring
│   │   ├── content_wowprogress.js   # Player filtering
│   │   └── content_rio.js           # Raider.IO integration
│   ├── options/
│   │   ├── options.html  # Settings UI
│   │   ├── options.js    # Settings logic
│   │   └── options.css   # Dark theme styling
│   └── utils/
│       └── storage.js    # Chrome storage wrapper
├── img/                   # Extension icons (16x16, 48x48, 128x128)
└── .git/                  # Version history (initial commit only)
```
