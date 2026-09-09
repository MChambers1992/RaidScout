/**
 * Regenerates the documentation screenshots in docs/screenshots/.
 *
 * The extension's own pages are plain HTML, so they render in a normal browser
 * once `chrome.*` is stubbed — no packed extension and no Chrome profile needed.
 * The parse-badge legend is built by calling the real `makeBadge()` from
 * src/content/common.js, so the documented badge states cannot drift from the
 * code that produces them.
 *
 * The Scout screenshots are generated the same way, through Scout's real code
 * path — the WoWProgress fetch adapter, the Raider.IO cross-reference and the
 * scoring pipeline all run as they would in a browser, with only their three
 * network calls stubbed from tools/scout-fixture.mjs. A screenshot therefore
 * cannot show a layout the code cannot actually produce. Scout is served over a
 * local HTTP server rather than file://, because its page is an ES module and
 * module imports are blocked on file:// origins.
 *
 * Playwright is not a project dependency (RaidScout has no build step and
 * `npm install` should stay light). Install it only when regenerating:
 *
 *     npm install --no-save playwright
 *     npx playwright install chromium
 *     node tools/screenshots.mjs
 *
 * Set CHROME_PATH to use a Chromium you already have.
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { wowprogressListingHtml, raiderioProfile, wclScore, tabHarvest } from './scout-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs/screenshots');
const launchOptions = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {};

/** A realistic, fully-configured install — the screenshots should show real values, not empty fields. */
const SYNC = {
    warcraftlogsEnabled: true, wowprogressEnabled: true,
    raiderioEnabled: true, guildsofwowEnabled: true,
    parseThreshold: 50, bestParseThreshold: 60,
    wclMinBestHealer: 55, wclMinMedianHealer: 45,
    wclMinBestTank: 0, wclMinMedianTank: 0,
    scoutPreflight: true, scoutOpenInBackground: false,
    wclSortByParse: true, wclCacheTtlHours: 6, wclConcurrency: 4,
    wclClientId: 'a1b2c3d4-5e6f-7890-abcd-ef1234567890',
    wclSearchParseThreshold: 0, wclMinMythicKills: 4,
    wclSelectedRegions: ['EU'], wclSelectedClasses: [],
    openWarcraftLogsTab: true, selectedRegions: ['EU'],
    minIlvl: 310, maxIlvl: 0, guildFilter: 'out',
    selectedClasses: [], wpWclEnabled: true,
    openWarcraftLogsFromRaiderIO: true, hideRaiderIoAds: true,
    rioMinIlvl: 310, rioSelectedRegions: ['EU'],
    rioSelectedRoles: [], rioSelectedClasses: [], rioWclEnabled: true,
    gowMinIlvl: 310, gowMinMythicKills: 4, gowMinMythicPlusScore: 2500,
    gowSelectedClasses: [], gowSelectedRoles: [], gowWclEnabled: true,
    // WarcraftLogs is not a harvest source (see RETIRED_SOURCE_IDS).
    scoutSources: ['wowprogress', 'raiderio', 'guildsofwow'],
    scoutMaxCandidates: 150, scoutPagesPerSource: 1,
    scoutWclEnabled: true, scoutHideBelowThresholds: true,
    scoutEnrichRaiderio: true,
};
const LOCAL = { wclClientSecret: '•'.repeat(32), wclDebug: false };
const RESPONSES = {
    getApiStatus: { state: 'ok', remainingMs: 0, hasCredentials: true },
    wclHasCredentials: { has: true },
    getClosedTabCount: { count: 7 },
    getLastScoutSkip: { skip: { name: 'Zugzugg', realm: 'draenor', best: 44, median: 38 } },
};

const chromeStub = `window.chrome = {
  runtime: {
    id: 'raidscout', lastError: null,
    getURL: (p) => p, openOptionsPage: () => {},
    onMessage: { addListener: () => {} },
    sendMessage: (msg, cb) => {
      const r = (${JSON.stringify(RESPONSES)})[msg && msg.action];
      if (cb) setTimeout(() => cb(r), 0);
      return Promise.resolve(r);
    },
  },
  storage: {
    sync:  { get: (k, cb) => { const d = ${JSON.stringify(SYNC)};  if (cb) setTimeout(() => cb(d), 0); return Promise.resolve(d); }, set: (o, cb) => cb && cb() },
    local: { get: (k, cb) => { const d = ${JSON.stringify(LOCAL)}; if (cb) setTimeout(() => cb(d), 0); return Promise.resolve(d); }, set: (o, cb) => cb && cb() },
    onChanged: { addListener: () => {} },
  },
  tabs: {
    query: (q, cb) => cb && cb([{ id: 1, url: 'https://www.wowprogress.com/gearscore/eu-tarren-mill?lfg=1' }]),
    create: () => {}, update: () => {}, reload: () => {},
  },
};`;

const browser = await chromium.launch(launchOptions);

async function shot(file, url, { width, height, sel = 'body', wait = 1200, prep } = {}) {
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
    await ctx.addInitScript(chromeStub);
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(wait);
    if (prep) await prep(page);
    await page.waitForTimeout(300);
    await page.locator(sel).screenshot({ path: path.join(OUT, file) });
    console.log('wrote', file);
    await ctx.close();
}

// The popup opens on the panel for the active tab's site — the stubbed tab is WoWProgress.
await shot('popup.png', `file://${ROOT}/src/popup/popup.html`, { width: 420, height: 900 });

// Options sections are cropped individually: the save bar is position:sticky and
// would otherwise sit across the middle of a full-page capture.
await shot('options-thresholds.png', `file://${ROOT}/src/options/options.html`, {
    width: 900, height: 1400, sel: '#crop',
    prep: async (page) => {
        await page.click('.tab-btn[data-tab="warcraftlogs"]');
        await page.waitForTimeout(300);
        await page.evaluate(() => {
            const label = [...document.querySelectorAll('.subsection-label')]
                .find(el => /Proactive Score Filter/i.test(el.textContent));
            const grid = document.querySelector('.threshold-grid');
            const crop = document.createElement('div');
            crop.id = 'crop';
            crop.style.cssText = 'padding:20px 24px;background:#2a2a2a;display:block;width:820px;box-sizing:border-box';
            label.parentNode.insertBefore(crop, label);
            crop.append(label, label.nextElementSibling, grid);
            document.querySelector('.save-area')?.remove();
        });
    },
});

await shot('options-wowprogress.png', `file://${ROOT}/src/options/options.html`, {
    width: 900, height: 1400, sel: '#wowprogress',
    prep: async (page) => {
        await page.click('.tab-btn[data-tab="wowprogress"]');
        await page.waitForTimeout(300);
        await page.evaluate(() => {
            document.querySelector('.save-area')?.remove();
            document.querySelector('#wowprogress').style.cssText += ';padding:16px 24px 24px;background:#2a2a2a;';
        });
    },
});

// Badge legend, rendered by the extension's own makeBadge().
{
    const ctx = await browser.newContext({ viewport: { width: 500, height: 620 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.setContent(`<!doctype html><meta charset=utf-8><style>
      body{margin:0;background:#1a1a1a;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;
           color:#ddd;padding:20px;display:inline-block}
      table{border-collapse:collapse} td{padding:7px 16px 7px 0;vertical-align:middle}
      td.desc{color:#8a8a8a;font-size:13px}
    </style><table id=t></table>`);
    await page.addScriptTag({ content: fs.readFileSync(path.join(ROOT, 'src/content/common.js'), 'utf8') });
    await page.evaluate(() => {
        const settings = { bestParseThreshold: 60, parseThreshold: 50, minBest: 60, minMedian: 50,
                           wclMinBestHealer: 0, wclMinMedianHealer: 0, wclMinBestTank: 0, wclMinMedianTank: 0 };
        const rows = [
            [{ best: 96, median: 91 }, 'Above your thresholds'],
            [{ best: 63, median: 52 }, 'Within 10% of a threshold'],
            [{ best: 44, median: 38 }, 'Below threshold — hidden'],
            ['no-logs',      'No WarcraftLogs data — hidden'],
            ['error',        'Lookup failed — stays visible'],
            ['rate-limited', 'API throttled — stays visible'],
            ['blocked',      'Cloudflare challenge — stays visible'],
            ['pending',      'Score still being fetched'],
        ];
        const t = document.getElementById('t');
        for (const [score, desc] of rows) {
            const tr = t.insertRow();
            tr.insertCell().appendChild(typeof score === 'string'
                ? makeBadge(score, null, settings, 'dps')
                : makeBadge('score', score, settings, 'dps'));
            const c = tr.insertCell();
            c.className = 'desc';
            c.textContent = desc;
        }
    });
    await page.waitForTimeout(300);
    await page.locator('body').screenshot({ path: path.join(OUT, 'parse-badges.png') });
    console.log('wrote parse-badges.png');
    await ctx.close();
}

// --- Scout -------------------------------------------------------------------
// Served over HTTP rather than file://: scout.js is an ES module, and module
// imports are blocked on file:// origins.
{
    const { CANDIDATES } = await import('./scout-fixture.mjs');

    const server = http.createServer((req, res) => {
        const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
        if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
        const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
                       '.jpg': 'image/jpeg', '.png': 'image/png' }[path.extname(file)] || 'text/plain';
        res.writeHead(200, { 'Content-Type': type });
        res.end(fs.readFileSync(file));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;

    const PROFILES = Object.fromEntries(
        CANDIDATES.map(c => [c.name.toLowerCase(), raiderioProfile(c.name)]));
    // Pre-computed in Node and inlined as data. Serialising wclScore() itself
    // would carry a function that closes over this module's fixture arrays,
    // which do not exist in the page: it throws on first call, the promise
    // behind requestWclScore never settles, and the run hangs at "Scoring 0/N".
    const SCORES = Object.fromEntries(
        CANDIDATES.map(c => [c.name.toLowerCase(), wclScore({ name: c.name })]));
    const TAB_ROWS = { raiderio: tabHarvest('raiderio'), guildsofwow: tabHarvest('guildsofwow') };

    // Stubs only the three network calls Scout makes. Everything else — the
    // WoWProgress parser, the cross-source merge, the Raider.IO hydration, the
    // scoring pipeline, the sort and the render — runs exactly as in the browser,
    // so a screenshot cannot show a layout the code could not produce.
    const scoutStub = `
      ${chromeStub}
      const __scores = ${JSON.stringify(SCORES)};
      const __canned = ${JSON.stringify(RESPONSES)};
      chrome.runtime.sendMessage = (msg, cb) => {
        const r = (msg && msg.action === 'fetchWclScore')
          ? (__scores[String(msg.character && msg.character.name).toLowerCase()]
             || { best: null, median: null, notFound: true })
          : __canned[msg && msg.action];
        if (cb) setTimeout(() => cb(r), 0);
        return Promise.resolve(r);
      };
      const __listing = ${JSON.stringify(wowprogressListingHtml())};
      const __profiles = ${JSON.stringify(PROFILES)};
      // The tab-mode sources open a background tab and ask its content script for
      // the visible rows. Stubbing the four tabs calls they use lets Raider.IO and
      // Guilds of WoW harvest here too, so the shot shows the cross-posting the
      // "Advertising on" column exists for rather than two sources marked "off".
      const __tabRows = ${JSON.stringify(TAB_ROWS)};
      chrome.tabs.create = async () => ({ id: 1, status: 'complete' });
      chrome.tabs.remove = async () => {};
      chrome.tabs.get = (id, cb) => cb({ id, status: 'complete' });
      chrome.tabs.onUpdated = { addListener: () => {}, removeListener: () => {} };
      chrome.tabs.onRemoved = { addListener: () => {}, removeListener: () => {} };
      chrome.tabs.sendMessage = (id, msg, cb) => cb({
        ok: true, source: msg.source, candidates: __tabRows[msg.source] || [],
      });

      window.fetch = async (url) => {
        const u = String(url);
        const body = u.includes('wowprogress.com')
          ? __listing
          : JSON.stringify(__profiles[(new URL(u).searchParams.get('name') || '').toLowerCase()]
                           || { statusCode: 400 });
        return { ok: true, status: 200, headers: { get: () => null },
                 text: async () => body, json: async () => JSON.parse(body) };
      };`;

    async function scoutShot(file, { width, height, sel = 'body', prep } = {}) {
        const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
        await ctx.addInitScript(scoutStub);
        const page = await ctx.newPage();
        await page.goto(`${origin}/src/scout/scout.html`, { waitUntil: 'networkidle' });
        // The page auto-runs a harvest on load. Wait for that run to report a
        // finished count rather than for a fixed delay, so a shot is never a
        // half-filled table.
        await page.waitForFunction(
            () => /candidates/.test(document.getElementById('progressLine').textContent),
            { timeout: 20000 });
        if (prep) await prep(page);
        await page.waitForTimeout(400);
        await page.locator(sel).screenshot({ path: path.join(OUT, file) });
        console.log('wrote', file);
        await ctx.close();
    }

    await scoutShot('scout-overview.png', { width: 1280, height: 820 });

    await scoutShot('scout-filters.png', {
        width: 1280, height: 900, sel: '.scout-filters',
        prep: async (page) => {
            await page.click('#toggleFilters');
            await page.waitForTimeout(200);
            // Three filters, matching the caption in docs/scout.md. The chip's
            // checkbox is visually hidden by design (only the box is restyled),
            // so click the label — which is what a user clicks too.
            await page.click('#filterRoles .filter-chip:has(input[value="healer"])');
            await page.click('#filterRegions .filter-chip:has(input[value="eu"])');
            await page.fill('#filterMinMplus', '2700');
            await page.dispatchEvent('#filterMinMplus', 'input');
            await page.waitForTimeout(300);
        },
    });

    // Below 900px the header and the table head stop being sticky and scroll
    // with the page (quirk 34); this shot is what documents that.
    await scoutShot('scout-narrow.png', { width: 720, height: 900 });

    server.close();
}

await browser.close();
