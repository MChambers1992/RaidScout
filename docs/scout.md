# Scout — every site in one list

[← Back to README](../README.md)

Scout answers one question: *who is looking for a guild right now that meets my
criteria?* — without opening four sites and reading four different layouts.

Click **🔎 Scout all sites** in the popup.

![The Scout results table](screenshots/scout-overview.png)

---

## What a run does

1. **Harvests** every source you've enabled. WoWProgress is read directly over
   the network. Raider.IO, WarcraftLogs recruitment and Guilds of WoW render
   their listings in the browser, so Scout opens each in a background tab for a
   few seconds, lets RaidScout's own content script filter it exactly as it
   would for you, reads the surviving rows and closes the tab.
2. **Filters** each site by that site's own settings — the item level, class,
   role and region filters you already configured in its tab.
3. **De-duplicates** across sites. The same player advertising on WoWProgress
   *and* Raider.IO *and* GoW becomes one row marked `×3` — and being on three
   sites at once is itself a signal they're actively looking.
4. **Scores** each unique player once through the WarcraftLogs API, with the
   same role-aware thresholds, 6-hour cache and rate-limit backoff as
   [proactive filtering](warcraftlogs-api.md).
5. **Ranks** everyone in a sortable table you can search, filter, copy as an
   in-game whisper list, or export to CSV.

---

## Narrowing the results

The **Filters** button opens role, class, region and source filters plus
minimums for item level, M+ score and mythic kills. The button carries a count
of how many are active, and the panel opens by itself if a filter is still set
from a previous session.

![Scout's filter panel, with three filters applied](screenshots/scout-filters.png)

In a narrow window the table drops its sticky header rather than tearing it
away from the rows beneath — all eleven columns stay readable and the page
scrolls normally.

<img src="screenshots/scout-narrow.png" width="520" alt="Scout in a narrow window, with the header and table head scrolling with the page">

Your filters and sort column are remembered between runs. The free-text search
box deliberately is not: it answers *"where is Thrall"* rather than *"who is
worth talking to"*, and a query restored weeks later would read as a harvest
that had lost most of its rows.

A minimum never rejects a stat the site didn't report. WoWProgress rows carry
no M+ score at all, so a minimum M+ score won't silently drop every WoWProgress
candidate — it only excludes people whose reported score is genuinely below it.

---

## No logs counts as below threshold

If WarcraftLogs has no parses for a candidate, Scout hides them along with the
low parses — someone with no parse at all can't be judged against a parse
threshold. This is the same rule the inline site filters use, so a candidate
hidden on WoWProgress is hidden in Scout for the same reason.

Candidates who *couldn't be scored* are never hidden: no API credentials,
scoring switched off, a rate limit part-way through a run, or a failed lookup
all leave the candidate visible with an explanatory badge. Those say nothing
about the player, and hiding on them would empty the whole list on a
misconfiguration. The counter above the table breaks the two apart —
`12 below thresholds · 5 with no logs` — and unticking **Hide below thresholds
& no logs** brings both back.

---

## When something goes wrong

Every other filter in RaidScout fails *open* — on an error it shows the
candidate rather than hiding them. Scout deliberately fails *visible* instead:
if a site returns nothing, its chip turns red and a banner says exactly which
site, why, and against which URL. A shortened list you trust is worse than a
visible error.

A source that loaded fine but matched nobody turns amber rather than red, and
several such sources are collapsed into one sentence rather than repeating the
same warning per site.

---

## Listing URLs

Each source has a default listing URL, overridable in **Settings → Scout →
Listing URLs**. Point one at the exact search you normally browse — a specific
realm, region or role — and Scout harvests that instead. This is also how you
repoint Scout yourself if a site moves its recruitment page.

---

## Why there's a candidate cap

Every candidate past de-duplication costs one WarcraftLogs API lookup, and the
API allows roughly 3,600 points per hour. The default cap of 150 keeps a run
comfortably inside that. Scores cache for 6 hours, so re-running over the same
people is nearly free. If Scout hits the rate limit mid-run it stops, keeps
everything already scored, and tells you how long to wait.

---

## Advertised role vs. ranked role

Scout scores candidates with the role WarcraftLogs actually ranked them as, not
the one the listing claimed. Where the two disagree, the role pill carries a
tooltip saying so — *"advertised as a healer, ranks as dps"*. That's a
recruitment signal, not a glitch.
