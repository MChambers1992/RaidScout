// tests/wowprogress-observer.test.js
// The WoWProgress content script's startup path, which decides when a missing
// table is worth reporting.
//
// This exists because of a real false alarm: Cloudflare serves its challenge at
// the listing's own URL, so the content script ran against the interstitial and
// warned "Selector not found (WoWProgress ratingContainer) — site markup may
// have changed". Nothing had changed; the page simply was not the site yet. A
// self-check that cries wolf is worse than none, because the next real warning
// is the one nobody reads.
//
// Driven through the real files rather than a copy: common.js and wowprogress.js
// are evaluated into a jsdom window with chrome stubbed, exactly as the browser
// loads them (common.js first, per the manifest).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const commonSource      = readFileSync(new URL('../src/content/common.js', import.meta.url), 'utf8');
const wowprogressSource = readFileSync(new URL('../src/content/wowprogress.js', import.meta.url), 'utf8');

const LISTING_URL = 'https://www.wowprogress.com/gearscore/?lfg=1&sortby=ts&raids_week=2&lang=en';

const REAL_LISTING = `
    <div class="ratingContainer"><table class="rating">
        <tr><th>Character</th><th>ilvl</th></tr>
        <tr><td class="character shaman"><a href="/character/eu/Tarren%20Mill/Thrall">Thrall</a></td>
            <td class="center">620</td></tr>
    </table></div>`;

// Cloudflare's interstitial, as both blocked sites actually serve it: the
// listing URL, a "Just a moment..." title, and no site markup at all.
const CHALLENGE_PAGE = '<div id="challenge-running"></div>';

function bootPage(html, title) {
    const dom = new JSDOM(`<!doctype html><head><title>${title}</title></head><body>${html}</body>`, {
        url: LISTING_URL,
        runScripts: 'outside-only',
        pretendToBeVisual: true,
    });

    const warnings = [];
    dom.window.console.warn = (...args) => warnings.push(args.join(' '));

    // Only what the script actually touches. sync.get invokes its callback
    // synchronously so the boot path runs before the test inspects it.
    dom.window.chrome = {
        storage: {
            sync: { get: (keys, cb) => cb({ wowprogressEnabled: true }) },
            // watchSettings() subscribes so WCL settings can be re-applied
            // without a reload; nothing here changes settings mid-test.
            onChanged: { addListener: () => {} },
        },
        runtime: { sendMessage: () => {}, onMessage: { addListener: () => {} }, lastError: null },
    };

    dom.window.eval(`${commonSource}\n${wowprogressSource}`);
    return { dom, warnings };
}

// The poll runs on a 2s interval; this advances the page's own timers.
function advanceSeconds(dom, seconds) {
    for (let i = 0; i < seconds / 2; i++) dom.window.eval('void 0');
    vi.advanceTimersByTime(seconds * 1000);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('startup on a Cloudflare interstitial', () => {
    it('says nothing at all, however long the challenge lasts', () => {
        // The reported bug. Passing the check reloads the page and re-runs this
        // script, so there is nothing to do meanwhile except keep quiet.
        const { dom, warnings } = bootPage(CHALLENGE_PAGE, 'Just a moment...');
        advanceSeconds(dom, 60);
        expect(warnings).toEqual([]);
    });

    it('still says nothing when the challenge carries no marker but the title', () => {
        const { dom, warnings } = bootPage('<p>Checking your browser</p>', 'Just a moment...');
        advanceSeconds(dom, 60);
        expect(warnings).toEqual([]);
    });
});

describe('startup on the real listing', () => {
    it('reports nothing when the table is present', () => {
        const { dom, warnings } = bootPage(REAL_LISTING, 'WoWProgress: Gear Score Rating');
        advanceSeconds(dom, 30);
        expect(warnings).toEqual([]);
    });

    it('marks the table filtered so the poll does not re-observe it every 2s', () => {
        const { dom } = bootPage(REAL_LISTING, 'WoWProgress: Gear Score Rating');
        advanceSeconds(dom, 10);
        expect(dom.window.document.querySelector('.ratingContainer table').dataset.filtered).toBe('true');
    });
});

describe('startup on a page that really has lost the container', () => {
    it('reports it once, after a grace period rather than immediately', () => {
        // The case assertSelector exists for. It must still fire — the fix was
        // to stop it firing for the wrong reason, not to silence it.
        const { dom, warnings } = bootPage('<div id="content">no table here</div>', 'WoWProgress');

        // Not on the first poll: a slow load must not read as broken markup.
        advanceSeconds(dom, 4);
        expect(warnings).toEqual([]);

        advanceSeconds(dom, 10);
        expect(warnings.length).toBe(1);
        expect(warnings[0]).toContain('.ratingContainer');
        expect(warnings[0]).toContain('site markup may have changed');
    });

    it('reports it once, not once per poll forever', () => {
        // The console is where a real problem has to be visible; a warning
        // repeating every two seconds buries everything else in it.
        const { dom, warnings } = bootPage('<div id="content"></div>', 'WoWProgress');
        advanceSeconds(dom, 120);
        expect(warnings.length).toBe(1);
    });
});
