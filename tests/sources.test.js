// tests/sources.test.js
// Tests the one adapter that parses markup itself: the WoWProgress fetch path.
// The tab-mode adapters delegate extraction to the live content scripts, so
// there is no markup here to test — their failure mode is covered by the
// harvest error handling in scout/scout.js instead.

import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { parseWowProgressDocument, DEFAULT_SOURCE_URLS, adapterFor, isCloudflareChallenge } from '../src/scout/sources.js';
import { normalizeCandidate, mergeCandidates } from '../src/scout/scout-core.js';

// Mirrors the markup wowprogress.js targets: a .rating table whose rows carry
// the class on .character, item level in td.center, and a /character/ link that
// is the only reliable source of region + realm.
function fixture(rows) {
    return new JSDOM(`<!doctype html><html><body>
        <div class="ratingContainer"><table class="rating">
            <tr><th>Character</th><th>ilvl</th><th>Guild</th></tr>
            ${rows}
        </table></div></body></html>`).window.document;
}

const row = ({
    href = '/character/eu/Tarren%20Mill/Thrall', cls = 'shaman',
    ilvl = '620', guild = false, spec = null,
} = {}) => `
    <tr>
        <td class="character ${cls}">
            ${spec ? `<img src="/img/spec_icon.png" alt="${spec}">` : ''}
            <a href="${href}">Thrall</a>
        </td>
        <td class="center">${ilvl}</td>
        <td>${guild ? '<span class="guild">Some Guild</span>' : ''}</td>
    </tr>`;

describe('parseWowProgressDocument', () => {
    it('skips the header row', () => {
        expect(parseWowProgressDocument(fixture(row()))).toHaveLength(1);
    });

    it('reads region, realm and name from the character link', () => {
        const [player] = parseWowProgressDocument(fixture(row()));
        expect(player.region).toBe('eu');
        expect(player.realm).toBe('tarren-mill');   // URL-encoded space slugged
        expect(player.name).toBe('Thrall');
    });

    it('reads class from the .character cell', () => {
        expect(parseWowProgressDocument(fixture(row({ cls: 'demon_hunter' })))[0].playerClass).toBe('demon_hunter');
    });

    it('parses item level as a number', () => {
        expect(parseWowProgressDocument(fixture(row({ ilvl: '618.63' })))[0].ilvl).toBe(618.63);
    });

    it('detects guild membership', () => {
        expect(parseWowProgressDocument(fixture(row({ guild: true })))[0].inGuild).toBe(true);
        expect(parseWowProgressDocument(fixture(row({ guild: false })))[0].inGuild).toBe(false);
    });

    it('derives role from the spec icon, or leaves it null', () => {
        expect(parseWowProgressDocument(fixture(row({ spec: 'Restoration Healer' })))[0].role).toBe('healer');
        expect(parseWowProgressDocument(fixture(row({ spec: 'Protection Tank' })))[0].role).toBe('tank');
        expect(parseWowProgressDocument(fixture(row({ spec: 'Fire' })))[0].role).toBe('dps');
        expect(parseWowProgressDocument(fixture(row()))[0].role).toBeNull();
    });

    it('builds an absolute profile link', () => {
        expect(parseWowProgressDocument(fixture(row()))[0].link)
            .toBe('https://www.wowprogress.com/character/eu/Tarren%20Mill/Thrall');
    });

    it('skips rows with no character link rather than throwing', () => {
        const doc = fixture('<tr><td class="character">No link here</td><td class="center">600</td></tr>');
        expect(parseWowProgressDocument(doc)).toEqual([]);
    });

    it('skips malformed character hrefs', () => {
        expect(parseWowProgressDocument(fixture(row({ href: '/character/eu' })))).toEqual([]);
    });

    it('returns an empty list for a page with no results table', () => {
        const doc = new JSDOM('<!doctype html><html><body><p>Nothing here</p></body></html>').window.document;
        expect(parseWowProgressDocument(doc)).toEqual([]);
    });

    it('feeds straight into the merge pipeline', () => {
        const parsed = parseWowProgressDocument(fixture(row() + row({ href: '/character/eu/Draenor/Jaina', cls: 'mage' })));
        const merged = mergeCandidates(parsed.map(p => normalizeCandidate(p, 'wowprogress')));
        expect(merged.map(c => c.name).sort()).toEqual(['Jaina', 'Thrall']);
    });
});

describe('adapter registry', () => {
    it('exposes one adapter per source with a default URL', () => {
        for (const id of ['wowprogress', 'raiderio', 'guildsofwow', 'warcraftlogs']) {
            expect(adapterFor(id)).toBeTruthy();
            expect(DEFAULT_SOURCE_URLS[id]).toMatch(/^https:\/\//);
        }
    });

    it('marks only WoWProgress as directly fetchable', () => {
        expect(adapterFor('wowprogress').mode).toBe('fetch');
        expect(adapterFor('raiderio').mode).toBe('tab');
        expect(adapterFor('guildsofwow').mode).toBe('tab');
        expect(adapterFor('warcraftlogs').mode).toBe('tab');
    });

    it('returns null for an unknown source', () => {
        expect(adapterFor('nope')).toBeNull();
    });
});

// Cloudflare in front of WoWProgress is why the fetch harvester needs a tab
// fallback at all. Misreading a challenge as a normal HTTP error, or as changed
// markup, is what used to send the officer off checking their listing URL.
describe('isCloudflareChallenge', () => {
    const html = '<html><head><title>Just a moment...</title></head><body></body></html>';

    it('spots the cf-mitigated header whatever the status', () => {
        expect(isCloudflareChallenge({ status: 200, header: n => (n === 'cf-mitigated' ? 'challenge' : '') }))
            .toBe(true);
    });

    it('spots a challenge status carrying a cf-ray', () => {
        const header = n => (n === 'cf-ray' ? '8a1b2c3d4e5f' : '');
        expect(isCloudflareChallenge({ status: 403, header })).toBe(true);
        expect(isCloudflareChallenge({ status: 503, header })).toBe(true);
    });

    it('spots the interstitial from the body alone', () => {
        // Response headers are not readable in every context, so the body
        // markers have to stand on their own.
        expect(isCloudflareChallenge({ status: 200, body: html })).toBe(true);
        expect(isCloudflareChallenge({ status: 403, body: '<div id="challenge-platform"></div>' })).toBe(true);
    });

    it('does not fire on a normal listing response', () => {
        expect(isCloudflareChallenge({
            status: 200,
            header: () => '',
            body: '<table class="rating"><tr><td>Someone</td></tr></table>',
        })).toBe(false);
    });

    it('does not treat an ordinary server error as a challenge', () => {
        // A 503 with no Cloudflare fingerprint is WoWProgress being down, which
        // the tab fallback cannot fix — it must stay a plain failure.
        expect(isCloudflareChallenge({ status: 503, header: () => '', body: 'Service Unavailable' })).toBe(false);
    });

    it('tolerates being called with nothing', () => {
        expect(isCloudflareChallenge()).toBe(false);
    });
});

// ─── Harvest paths ─────────────────────────────────────────────────────────────
// The WoWProgress adapter is the only one that fetches and parses for itself,
// and the only one with two harvest routes. What matters here is the crossover:
// Cloudflare challenges the direct request, and the listing has to come back
// through a background tab instead of turning into a misleading "check your
// listing URL" error.

import { vi, beforeEach, afterEach } from 'vitest';

const LISTING = 'https://www.wowprogress.com/gearscore/?lfg=1';

function htmlResponse(body, { status = 200, headers = {} } = {}) {
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: n => lower[String(n).toLowerCase()] ?? null },
        text: async () => body,
    };
}

const listingHtml = rows => `<!doctype html><html><body>
    <div class="ratingContainer"><table class="rating">
        <tr><th>Character</th><th>ilvl</th><th>Guild</th></tr>${rows}
    </table></div></body></html>`;

// A challenge as Cloudflare actually serves it: a 403 whose body is the
// interstitial rather than the listing.
const challenge = () => htmlResponse('<title>Just a moment...</title>', {
    status: 403, headers: { 'cf-ray': '8a1b2c3d', 'content-type': 'text/html' },
});

// Timers the tabs mock scheduled, cleared on teardown so a late 'complete'
// callback cannot fire into a torn-down global.
const pendingTimers = [];

// chrome.tabs stand-in. onUpdated fires 'complete' as soon as a listener
// registers, because harvestViaTab only attaches it after the create resolves.
function installTabsChrome(harvestResponse) {
    let nextId = 1;
    let lastTabId = null;
    const created = [];
    const removed = [];
    globalThis.chrome = {
        runtime: { lastError: null },
        tabs: {
            create: async ({ url }) => {
                const tab = { id: nextId++, url };
                lastTabId = tab.id;
                created.push(tab);
                return tab;
            },
            remove: async (id) => { removed.push(id); },
            // waitForTabComplete polls once in case the load finished between
            // create() and the listener being attached.
            get: (id, cb) => cb({ id, status: 'loading' }),
            sendMessage: (tabId, message, cb) => cb(harvestResponse),
            onUpdated: {
                addListener: (fn) => {
                    pendingTimers.push(setTimeout(() => fn(lastTabId, { status: 'complete' }), 0));
                },
                removeListener: () => {},
            },
            onRemoved: { addListener: () => {}, removeListener: () => {} },
        },
    };
    return { created, removed };
}

const wpAdapter = () => adapterFor('wowprogress');

// ctx as scout.js builds it.
const ctx = (settings = {}, pagesPerSource = 1) => ({
    pagesPerSource,
    settings: { selectedRegions: ['eu'], guildFilter: 'any', ...settings },
});

beforeEach(() => {
    globalThis.DOMParser = new JSDOM().window.DOMParser;
});

afterEach(() => {
    while (pendingTimers.length) clearTimeout(pendingTimers.pop());
    delete globalThis.fetch;
    delete globalThis.chrome;
});

describe('WoWProgress fetch harvest', () => {
    it('returns the parsed rows and sends cookies with the request', () => {
        // credentials must not be 'omit': that is what stopped an existing
        // cf_clearance cookie from ever being presented.
        const fetchMock = vi.fn(async () => htmlResponse(listingHtml(row())));
        globalThis.fetch = fetchMock;

        return wpAdapter().run(LISTING, ctx()).then(result => {
            expect(result.ok).toBe(true);
            expect(result.candidates).toHaveLength(1);
            expect(fetchMock.mock.calls[0][1].credentials).toBe('include');
        });
    });

    it('applies the WoWProgress filters itself, having no content script', async () => {
        globalThis.fetch = vi.fn(async () => htmlResponse(listingHtml(row({ ilvl: '600' }))));
        const result = await wpAdapter().run(LISTING, ctx({ minIlvl: 615 }));
        expect(result.candidates).toHaveLength(0);
    });

    it('paginates with next_page and stops at an empty page', async () => {
        const fetchMock = vi.fn(async (url) =>
            htmlResponse(String(url).includes('next_page') ? listingHtml('') : listingHtml(row())));
        globalThis.fetch = fetchMock;

        const result = await wpAdapter().run(LISTING, ctx({}, 3));
        expect(result.candidates).toHaveLength(1);
        expect(fetchMock.mock.calls[1][0]).toContain('next_page=1');
    });

    it('throws on a first-page HTTP error, for harvestSource to report', async () => {
        // A hard failure is raised, not returned: scout.js wraps adapter.run in
        // a try/catch and turns it into the red chip and banner.
        globalThis.fetch = vi.fn(async () => htmlResponse('nope', { status: 500 }));
        await expect(wpAdapter().run(LISTING, ctx())).rejects.toThrow(/500/);
    });

    it('fails with a markup hint when the results table is missing', async () => {
        globalThis.fetch = vi.fn(async () => htmlResponse('<html><body>hello</body></html>'));
        await expect(wpAdapter().run(LISTING, ctx())).rejects.toThrow(/\.rating/);
    });
});

describe('WoWProgress Cloudflare fallback', () => {
    const tabRows = [{
        name: 'Thrall', realm: 'tarren-mill', region: 'eu',
        playerClass: 'shaman', role: 'healer', ilvl: 620, inGuild: false,
    }];

    it('harvests through a background tab when the first page is challenged', async () => {
        globalThis.fetch = vi.fn(async () => challenge());
        const { created, removed } = installTabsChrome({ ok: true, candidates: tabRows, url: LISTING });

        const result = await wpAdapter().run(LISTING, ctx());

        expect(result.ok).toBe(true);
        expect(result.candidates).toHaveLength(1);
        expect(created).toHaveLength(1);
        expect(removed).toHaveLength(1);              // quirk 28: never strand a tab
        expect(result.warnings.join(' ')).toMatch(/Cloudflare/i);
    });

    it('still applies the officer filters to rows the tab returned', async () => {
        // The content script would normally filter, but it does not run at all
        // when the WoWProgress integration is switched off.
        globalThis.fetch = vi.fn(async () => challenge());
        installTabsChrome({ ok: true, candidates: tabRows, url: LISTING });

        const result = await wpAdapter().run(LISTING, ctx({ minIlvl: 630 }));
        expect(result.candidates).toHaveLength(0);
    });

    it('keeps earlier pages when the challenge lands mid-pagination', async () => {
        // Falling back would re-read page one only, handing back fewer rows
        // than are already in hand.
        globalThis.fetch = vi.fn(async (url) =>
            String(url).includes('next_page') ? challenge() : htmlResponse(listingHtml(row())));
        const { created } = installTabsChrome({ ok: true, candidates: tabRows });

        const result = await wpAdapter().run(LISTING, ctx({}, 2));

        expect(result.ok).toBe(true);
        expect(result.candidates).toHaveLength(1);
        expect(created).toHaveLength(0);              // no tab opened
        expect(result.warnings.join(' ')).toMatch(/Cloudflare/i);
    });

    it('explains itself instead of opening a tab for a non-gearscore listing', async () => {
        // The content script is only injected on /gearscore/, so a repointed
        // listing would just time out with nothing to harvest it.
        globalThis.fetch = vi.fn(async () => challenge());
        const { created } = installTabsChrome({ ok: true, candidates: tabRows });

        const result = await wpAdapter().run('https://www.wowprogress.com/lfg/', ctx());

        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/gearscore/);
        expect(created).toHaveLength(0);
    });

    it('names both failures when the tab fallback fails too', async () => {
        globalThis.fetch = vi.fn(async () => challenge());
        installTabsChrome({ ok: false, candidates: [], error: 'nothing rendered' });

        const result = await wpAdapter().run(LISTING, ctx());

        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/Cloudflare/i);
        expect(result.error).toMatch(/nothing rendered/);
    });
});
