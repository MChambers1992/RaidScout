# Scout — every site in one list

[← Back to README](../README.md)

Scout answers one question: *who is looking for a guild right now that meets my
criteria?* — without opening three sites and reading three different layouts.

Click **🔎 Scout all sites** in the popup.

![The Scout results table](screenshots/scout-overview.png)

---

## What a run does

1. **Harvests** every source you've enabled. WoWProgress is read directly over
   the network. Raider.IO and Guilds of WoW render their listings in the
   browser, so Scout opens each in a background tab for a few seconds, lets
   RaidScout's own content script filter it exactly as it would for you, reads
   the surviving rows and closes the tab.
2. **Filters** each site by that site's own settings — the item level, class,
   role and region filters you already configured in its tab.
3. **De-duplicates** across sites. The same player advertising on WoWProgress
   *and* Raider.IO *and* GoW becomes one row, and the **Advertising on** column
   names all three — being on three sites at once is itself a signal they're
   actively looking.
4. **Scores** each unique player once through the WarcraftLogs API, with the
   same role-aware thresholds, 6-hour cache and rate-limit backoff as
   [proactive filtering](warcraftlogs-api.md). This runs first because it is
   what decides who you look at, and it is the faster of the two lookups.
5. **Cross-references** the candidates that survived against Raider.IO's
   public character API, to fill in M+ score, mythic progress and item level
   (see below). Only the survivors, because looking someone up after the
   thresholds rejected them spends a request on a row you won't see.
6. **Ranks** everyone in a sortable table you can search, filter, copy as an
   in-game whisper list, or export to CSV.

---

## Every candidate gets the same columns

The three sites publish wildly different stats. A WoWProgress row has an item
level and nothing else — no M+ score, no raid progress. Raider.IO's search table
adds a role. Only Guilds of WoW prints all three. So a blank M+ cell used to
mean *"the site they happened to post on doesn't print that"*, which tells you
nothing about the player.

**Cross-reference stats with Raider.IO** (Settings → Scout, on by default) looks
every candidate up on Raider.IO's public character API and fills in the gaps:
M+ score, current-tier mythic kills, item level, class and spec. It needs no API
key and no sign-in.

Two rules keep it from doing harm:

- **It only fills gaps and refreshes numbers.** A stat takes whichever reading
  is higher, since gear and progress only go up. A role a site *stated* is never
  overwritten — that came from the recruit's own advert, whereas Raider.IO
  reports whichever spec they last logged out in.
- **A failed lookup changes nothing and says nothing.** Raider.IO has never
  heard of plenty of legitimate fresh alts, so a miss simply leaves the row as
  the listing described it rather than raising a warning you can't act on.

Class and role also come free where they can be deduced: hunters, mages, rogues
and warlocks have no tank or healer specialisation, so knowing the class settles
the role outright — no markup guessing, no API call.

Mythic progress is shown as a fraction — **6/8**, not 6 — because a kill count
means nothing without the tier's boss count, and that count changes every
raid. Candidates whose kills came from a listing that prints no total show
the bare number.

Turn it off if you'd rather the run finish faster, or if you only care about
parses.

### Listed

**Listed** is how long ago the character posted — or last bumped — their
looking-for-guild listing, with the exact date on hover. Click the header to
put the freshest listings first: someone who posted yesterday is looking now,
someone who posted months ago may well have found a guild. A player on more
than one site shows their most recent listing. Rows whose site printed no
readable date show "—" and always sort to the bottom, whichever direction you
sort in — a missing date is never guessed as "now".

### Heroic vs. mythic parses

Mythic and heroic parses are not on one scale — the mythic field is stronger,
so a mythic 60% can be the better player than a heroic 80%. Sorting by **WCL
parse** therefore groups them: every mythic parse first, highest to lowest, then
every heroic parse, then normal. Each badge is tagged **M** or **H** so you can
see where one group ends. (A score cached before this was recorded has no
difficulty and sorts after the known ones until the cache refreshes — six hours
by default, or clear it in Settings → WarcraftLogs.) The same grouping applies
to **Sort lists by parse** on the sites themselves.

By default WarcraftLogs reports each character's parses from the hardest
difficulty they have logs on, so a raider with a single mythic kill is ranked
on mythic parses while everyone else is ranked on heroic — not a like-for-like
comparison. The **Parses** picker in the toolbar pins scoring to **Heroic only**
(or **Mythic only**) and re-scores the table on the spot; badges then read
`WCL H 85% / 70%`. It is the same setting as **Compare parses from** in
Settings → WarcraftLogs, so the sites and Scout always agree. Scores are cached
per difficulty, so switching back and forth costs each character one lookup
per setting. Note that someone with no logs at the chosen difficulty counts as
*no logs* and is hidden with the others when "Hide below thresholds & no logs"
is on.

---

## Why WarcraftLogs isn't a source

Scout harvests names from WoWProgress, Raider.IO and Guilds of WoW. It used to
read the WarcraftLogs recruitment page too, by opening it in a background tab —
and that was the least reliable part of a run, because WarcraftLogs sits behind
an aggressive Cloudflare configuration. The source that most needed a browser tab
was the one most likely to be handed a security check instead of a listing.

The obvious fix — asking the WarcraftLogs API for the listing, the way RaidScout
already asks it for parses — isn't available. Their v2 API covers characters,
guilds, reports, rankings and game data; there is nothing in it that describes a
recruitment post. The recruitment page's Discord integration is an outbound
webhook (WarcraftLogs *posting* new adverts to a channel), not something an
application can query.

So WarcraftLogs does the thing only it can do: **every candidate in the table is
still ranked by WarcraftLogs parses**, fetched through your API credentials
exactly as before. Nothing about scoring, thresholds or badges changed.

If you like reading `warcraftlogs.com/recruitment` yourself, that page still gets
RaidScout's filters and inline parse badges — see
[WarcraftLogs API](warcraftlogs-api.md). It just isn't somewhere Scout goes on
your behalf any more.

---

## Narrowing the results

The **Filters** button opens role, class, region and source filters, minimums
for item level and M+ score, a **mythic kills** range — set a maximum to leave
out raiders already further than your guild, since an 8/8 player is unlikely to
join a 4/8 team but a 5/8 one might — and **Listed within** — hide anyone
whose listing is older than 24 hours to 90 days. A listing with no readable date
is kept, the same way a minimum never rejects a stat the site didn't report. The button carries a count
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
if a site returns nothing, its chip turns red and a notice says exactly which
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

## Loading more

Read to the bottom of the table and a **Load more** button fetches the next
page of every source that still has one, scores the new candidates and adds
them to the table — anyone already listed just picks up the new site in
*Advertising on*. Candidates the cap held back come first, since they are
already harvested. It is a button rather than infinite scroll because every new
candidate is a WarcraftLogs API call.

The line under the button says what is left and why a source stopped: the end
of its listing, or — for a listing sorted newest-first — listings older than
your **Listed within** filter, in which case widening the filter re-opens it.
Raider.IO's and Guilds of WoW's page parameter could not be verified against
the live sites; if one hands back rows already loaded, Scout says so and stops
asking that source rather than repeating itself.

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
