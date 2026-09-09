/**
 * Regenerates the documentation screenshots in docs/screenshots/.
 *
 * The extension's own pages are plain HTML, so they render in a normal browser
 * once `chrome.*` is stubbed — no packed extension and no Chrome profile needed.
 * The parse-badge legend is built by calling the real `makeBadge()` from
 * src/content/common.js, so the documented badge states cannot drift from the
 * code that produces them.
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
    minIlvl: 630, maxIlvl: 0, guildFilter: 'out',
    selectedClasses: [], wpWclEnabled: true,
    openWarcraftLogsFromRaiderIO: true, hideRaiderIoAds: true,
    rioMinIlvl: 630, rioSelectedRegions: ['EU'],
    rioSelectedRoles: [], rioSelectedClasses: [], rioWclEnabled: true,
    gowMinIlvl: 630, gowMinMythicKills: 4, gowMinMythicPlusScore: 2800,
    gowSelectedClasses: [], gowSelectedRoles: [], gowWclEnabled: true,
    scoutSources: ['wowprogress', 'raiderio', 'warcraftlogs', 'guildsofwow'],
    scoutMaxCandidates: 150, scoutPagesPerSource: 1,
    scoutWclEnabled: true, scoutHideBelowThresholds: true,
};
const LOCAL = { wclClientSecret: '•'.repeat(32), wclDebug: false };
const RESPONSES = {
    getApiStatus: { state: 'ok', remainingMs: 0, hasCredentials: true },
    wclHasCredentials: { hasCredentials: true },
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

await browser.close();
console.log('\nNote: the Scout screenshots (scout-*.png) are captured from a live run and are not regenerated here.');
