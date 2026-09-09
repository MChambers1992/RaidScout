# Troubleshooting

[← Back to README](../README.md)

---

## Filtering

**Proactive filtering isn't hiding anyone**
- Check that **Enable proactive WCL filtering** is on for the relevant site in Full Settings
- Click **Test connection** in the WarcraftLogs tab to confirm your credentials work
- Check that you've set at least one threshold — all zeros means no filtering
- If the popup shows "🚦 WCL rate limited" or "☁ Cloudflare check", wait for the cooldown or click **Clear cached scores**

**The filter cleared everyone / the list is empty**
- Characters WarcraftLogs has no parses for are always hidden when proactive filtering is on. On a low-population realm, or early in a tier, that can be most of the list
- Lower your thresholds, or turn proactive filtering off for that site
- Refresh the page — some site SPAs can end up with stale filter state

**Settings changed but the page didn't update**
- WCL filter settings propagate live, no refresh needed
- Standard filters (item level, class, region) need a page reload on WoWProgress; Raider.IO and Guilds of WoW react live

---

## Badges and the API

**Parse badges show "⚠ WCL err"**
- A transient lookup failure — the character stays visible, because filtering always fails open
- If it persists across refreshes, check the service worker console: `chrome://extensions/` → RaidScout → **Service worker** → **inspect**. Look for `[RaidScout WCL]` lines (turn on debug logging in Full Settings for more detail)

**"☁ Cloudflare check" in the popup, or `☁ CF check` badges on rows**
- WarcraftLogs is challenging RaidScout's API requests. This is not a credentials problem
- Open **warcraftlogs.com** in a tab and complete the check. RaidScout retries as soon as a real WarcraftLogs page loads — you don't need to wait out the countdown
- While it's active nothing is filtered out: scouting falls back to opening tabs, and list filtering leaves everyone visible

---

## Scouting (auto-opened tabs)

**Auto-open WarcraftLogs isn't working on WoWProgress**
- Make sure you're on a character page, not a realm listing page
- Confirm **Auto-open WarcraftLogs** is on in Full Settings → WoWProgress, and that the site toggle is enabled
- If nothing opened, check the popup's badge — the pre-flight check may have skipped them for being below threshold. The popup shows the most recent skip with their parse

**Everyone's tabs are opening even though they're bad parses**
- Pre-flight needs API credentials. Without them RaidScout opens the tab first and closes it afterwards, which is the older behaviour
- Confirm **Check parses before opening a tab** is on in Full Settings → WarcraftLogs
- Check the popup for a rate-limit or Cloudflare countdown — both make scouting fail open on purpose

---

## Scout

**A Scout source returned nothing**
- The banner names the site, the reason and the URL it used. Open that URL yourself: if the listing looks fine in your browser but Scout saw nothing, the site changed its markup
- A "No results rendered within Ns" error on Raider.IO, WarcraftLogs or Guilds of WoW usually means the page wanted a sign-in, or the listing URL is wrong — override it in Settings → Scout → Listing URLs
- WoWProgress is fetched directly, so it fails differently: an HTTP status or "No results table (.rating)" means the URL is wrong or the markup changed. If WoWProgress is behind a Cloudflare challenge, Scout automatically retries it through a background tab, which reuses the clearance your browser already holds. An interactive click-to-solve challenge defeats both — open wowprogress.com, clear it, and run Scout again

**Scout is hiding people who look fine on the site**
- Candidates with no WarcraftLogs parses are hidden by **Hide below thresholds & no logs**. The counter above the table shows how many; untick it to see them
- Check the **Filters** button — a filter from a previous session may still be active. The count sits on the button, and **Clear filters** resets them

**Scout found fewer candidates than the sites show**
- Each source is filtered by its own tab's settings before Scout ever sees it — a strict item-level or class filter on one site applies to that site's Scout results too
- De-duplication merges cross-posted players, so 60 + 45 + 20 listing rows is usually well under 125 unique people
- Check the candidate cap in Settings → Scout if the banner mentions it

**Scout is slow**
- The three browser-rendered sources each need a few seconds of real page load. WoWProgress, fetched directly, returns almost instantly
- Turn off sources you don't use in Settings → Scout
- The second run of the day is much faster: parses cache for 6 hours

---

## Starting over

**I want to reset everything**
- In Full Settings, use **Export Settings** to back up first
- Then clear storage via `chrome://extensions/` → RaidScout → **Details** → **Extension options** → clear site data

---

Still stuck? Open an [issue](https://github.com/MChambers1992/RaidScout/issues)
with what you did, what you expected and what happened.
