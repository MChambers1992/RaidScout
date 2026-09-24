// tests/background-tabs.test.js
// Every way the service worker opens or closes a tab on the user's behalf.
//
// Each of these failed silently in the browser — the wrong tab vanished, or a
// duplicate appeared — so they are pinned here against a stubbed `chrome`:
//
//   - pre-flight closed the WoWProgress source tab by id after an async lookup,
//     taking the listing with it if the user had pressed Back meanwhile
//   - onCompleted fires for every load of the page, so a Cloudflare challenge
//     (which reloads the same URL) or a refresh opened a second WCL tab
//   - the WCL backstop closed any WarcraftLogs tab below threshold, including
//     ones the user opened themselves, plus every WoWProgress tab of that name
//   - openWarcraftLogsTab defaults to on in the UI but was read as truthy, so an
//     install that never saved settings never auto-opened anything
//   - a query string or hash on the WoWProgress URL leaked into the WCL name
//
// background.js registers its listeners at import time, so the stub records
// them and the tests fire them directly.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

const CANDIDATE = 'https://www.wowprogress.com/character/eu/tarren-mill/Thrall';
const LISTING   = 'https://www.wowprogress.com/gearscore/eu?lfg=1&raids_week=';
const WCL_THRALL = 'https://www.warcraftlogs.com/character/eu/tarren-mill/Thrall';

let bg;
let tabs, removed, created, nextTabId;
let syncData, sessionData;
const listeners = { onCompleted: [], onMessage: [], onRemoved: [] };

// Resolves once every pending microtask/timer chain the listeners started has
// run; the listeners are fire-and-forget, so there is nothing to await.
const settle = () => new Promise(r => setTimeout(r, 0));

beforeAll(async () => {
    const noop = () => {};
    const area = store => ({
        get: async keys => {
            const data = store();
            if (keys == null) return { ...data };
            const list = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(list.filter(k => k in data).map(k => [k, data[k]]));
        },
        set: async obj => { Object.assign(store(), structuredClone(obj)); },
        remove: async keys => { for (const k of [].concat(keys)) delete store()[k]; },
    });
    const syncArea = area(() => syncData);
    globalThis.chrome = {
        runtime: {
            id: 'x',
            getURL: (p = '') => 'chrome-extension://x/' + p,
            onMessage: { addListener: fn => listeners.onMessage.push(fn) },
            sendMessage: () => Promise.resolve(),
        },
        storage: {
            local: area(() => ({})),
            sync: {
                ...syncArea,
                // The navigation listener uses the callback form.
                get: (keys, cb) => {
                    const p = syncArea.get(keys);
                    if (typeof cb === 'function') { p.then(cb); return undefined; }
                    return p;
                },
            },
            session: area(() => sessionData),
        },
        action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
        tabs: {
            onRemoved: { addListener: fn => listeners.onRemoved.push(fn) },
            query: async () => [],
            get: async id => {
                if (!tabs.has(id)) throw new Error(`No tab with id: ${id}.`);
                return tabs.get(id);
            },
            create: async ({ url, active }) => {
                const tab = { id: nextTabId++, url, active };
                tabs.set(tab.id, tab);
                created.push(tab);
                return tab;
            },
            remove: async id => { removed.push(id); tabs.delete(id); },
        },
        webNavigation: { onCompleted: { addListener: fn => listeners.onCompleted.push(fn) } },
    };
    bg = await import('../src/background.js');
});

beforeEach(() => {
    tabs = new Map();
    removed = [];
    created = [];
    // Fresh ids per test: the repeat-visit guard is module state keyed by tab.
    nextTabId = (nextTabId ?? 1000) + 1000;
    syncData = {};
    sessionData = {};
});

function newTab(url) {
    const tab = { id: nextTabId++, url };
    tabs.set(tab.id, tab);
    return tab;
}

function navigate(tab, url = tab.url) {
    for (const fn of listeners.onCompleted) fn({ frameId: 0, tabId: tab.id, url });
}

function sendFromTab(tab, message) {
    for (const fn of listeners.onMessage) fn(message, { id: 'x', url: tab.url, tab }, () => {});
}

// ─── Source-tab close on a pre-flight reject ──────────────────────────────────

describe('closeTabIfStillOn', () => {
    it('closes the tab when it still shows the rejected candidate', async () => {
        const tab = newTab(CANDIDATE);
        expect(await bg.closeTabIfStillOn(tab.id, CANDIDATE)).toBe(true);
        expect(removed).toEqual([tab.id]);
    });

    it('leaves the tab alone once the user has gone back to the listing', async () => {
        // Click a name on the listing (same tab), press Back before the API
        // answers, and the listing tab used to be closed.
        const tab = newTab(LISTING);
        expect(await bg.closeTabIfStillOn(tab.id, CANDIDATE)).toBe(false);
        expect(removed).toEqual([]);
    });

    it('leaves the tab alone once the user has moved on to another candidate', async () => {
        const tab = newTab('https://www.wowprogress.com/character/eu/tarren-mill/Jaina');
        expect(await bg.closeTabIfStillOn(tab.id, CANDIDATE)).toBe(false);
        expect(removed).toEqual([]);
    });

    it('leaves the tab alone while it is navigating away', async () => {
        const tab = newTab(CANDIDATE);
        tab.pendingUrl = LISTING;
        expect(await bg.closeTabIfStillOn(tab.id, CANDIDATE)).toBe(false);
        expect(removed).toEqual([]);
    });

    it('does nothing when the tab is already gone', async () => {
        expect(await bg.closeTabIfStillOn(424242, CANDIDATE)).toBe(false);
        expect(removed).toEqual([]);
    });
});

describe('isSameWowProgressCharacter', () => {
    it('ignores query string, hash and region/realm case', () => {
        expect(bg.isSameWowProgressCharacter(CANDIDATE + '?x=1#gear',
            'https://www.wowprogress.com/character/EU/Tarren-Mill/Thrall')).toBe(true);
    });

    it('treats an encoded and a decoded name as the same character', () => {
        expect(bg.isSameWowProgressCharacter(
            'https://www.wowprogress.com/character/eu/kazzak/Ch%C3%A9',
            'https://www.wowprogress.com/character/eu/kazzak/Ché')).toBe(true);
    });

    it('distinguishes different characters and non-character pages', () => {
        expect(bg.isSameWowProgressCharacter(CANDIDATE, CANDIDATE.replace('Thrall', 'Jaina'))).toBe(false);
        expect(bg.isSameWowProgressCharacter(LISTING, LISTING)).toBe(false);
        expect(bg.isSameWowProgressCharacter('not a url', 'not a url')).toBe(false);
    });
});

// ─── WoWProgress → WarcraftLogs URL ───────────────────────────────────────────

describe('buildWarcraftLogsUrl', () => {
    it('maps a character page onto its WarcraftLogs URL', () => {
        expect(bg.buildWarcraftLogsUrl(CANDIDATE)).toBe(WCL_THRALL);
    });

    it('drops a query string or hash instead of folding it into the name', () => {
        expect(bg.buildWarcraftLogsUrl(CANDIDATE + '?tab=gear')).toBe(WCL_THRALL);
        expect(bg.buildWarcraftLogsUrl(CANDIDATE + '#pve')).toBe(WCL_THRALL);
    });

    it('lower-cases region and realm but not the name', () => {
        expect(bg.buildWarcraftLogsUrl('https://www.wowprogress.com/character/EU/Tarren-Mill/Thrall'))
            .toBe(WCL_THRALL);
    });

    it('returns null for anything that is not a character page', () => {
        expect(bg.buildWarcraftLogsUrl(LISTING)).toBeNull();
        expect(bg.buildWarcraftLogsUrl('https://www.wowprogress.com/character/eu/tarren-mill')).toBeNull();
        expect(bg.buildWarcraftLogsUrl('not a url')).toBeNull();
    });
});

// ─── Repeat-visit guard ───────────────────────────────────────────────────────

describe('claimScout', () => {
    it('claims a character once per source tab inside the window', () => {
        const t = 10_000_000;
        expect(bg.claimScout(1, WCL_THRALL, t)).toBe(true);
        expect(bg.claimScout(1, WCL_THRALL, t + 1_000)).toBe(false);
        // Name case is not identity on WarcraftLogs.
        expect(bg.claimScout(1, WCL_THRALL.replace('Thrall', 'thrall'), t + 2_000)).toBe(false);
    });

    it('lets the same character through again once the window has passed', () => {
        const t = 20_000_000;
        expect(bg.claimScout(2, WCL_THRALL, t)).toBe(true);
        expect(bg.claimScout(2, WCL_THRALL, t + bg.SCOUT_REPEAT_WINDOW_MS)).toBe(true);
    });

    it('treats another tab or another character as a new visit', () => {
        const t = 30_000_000;
        expect(bg.claimScout(3, WCL_THRALL, t)).toBe(true);
        expect(bg.claimScout(4, WCL_THRALL, t)).toBe(true);
        expect(bg.claimScout(3, WCL_THRALL.replace('Thrall', 'Jaina'), t)).toBe(true);
    });
});

// ─── Navigation listener ──────────────────────────────────────────────────────

describe('WoWProgress character visit', () => {
    it('opens a WarcraftLogs tab on an install that never saved its settings', async () => {
        // openWarcraftLogsTab defaults to on; a truthy read treated "absent"
        // as off and the feature did nothing until the first Save.
        const source = newTab(CANDIDATE);
        navigate(source);
        await settle();
        expect(created.map(t => t.url)).toEqual([WCL_THRALL]);
    });

    it('opens nothing when the user switched it off', async () => {
        syncData.openWarcraftLogsTab = false;
        navigate(newTab(CANDIDATE));
        await settle();
        expect(created).toEqual([]);
    });

    it('opens one tab when the page completes twice (Cloudflare challenge, then the page)', async () => {
        const source = newTab(CANDIDATE);
        navigate(source);
        navigate(source);
        await settle();
        navigate(source);   // a refresh a moment later
        await settle();
        expect(created.map(t => t.url)).toEqual([WCL_THRALL]);
    });

    it('still opens a tab for the next candidate in the same tab', async () => {
        const source = newTab(CANDIDATE);
        navigate(source);
        await settle();
        source.url = CANDIDATE.replace('Thrall', 'Jaina');
        navigate(source);
        await settle();
        expect(created.map(t => t.url)).toEqual([WCL_THRALL, WCL_THRALL.replace('Thrall', 'Jaina')]);
    });

    it('ignores subframes', async () => {
        const source = newTab(CANDIDATE);
        for (const fn of listeners.onCompleted) fn({ frameId: 3, tabId: source.id, url: CANDIDATE });
        await settle();
        expect(created).toEqual([]);
    });
});

// ─── WarcraftLogs backstop close ──────────────────────────────────────────────

describe('parseThresholdFailed', () => {
    async function scoutFrom(source) {
        navigate(source);
        await settle();
        return created.at(-1);
    }

    it('closes a tab the extension opened, and the WoWProgress page that asked for it', async () => {
        const source = newTab(CANDIDATE);
        const wcl = await scoutFrom(source);
        sendFromTab(wcl, { action: 'parseThresholdFailed', warcraftLogsUrl: WCL_THRALL, score: { best: 10, median: 5 } });
        await settle();
        expect(removed.sort()).toEqual([source.id, wcl.id].sort());
        expect(sessionData.lastScoutSkip).toMatchObject({ name: 'Thrall' });
    });

    it('leaves the WoWProgress tab open once it has moved on', async () => {
        const source = newTab(CANDIDATE);
        const wcl = await scoutFrom(source);
        source.url = LISTING;
        sendFromTab(wcl, { action: 'parseThresholdFailed', warcraftLogsUrl: WCL_THRALL });
        await settle();
        expect(removed).toEqual([wcl.id]);
    });

    it('never closes a WarcraftLogs tab the user opened themselves', async () => {
        // The settings promise to close an *auto-opened* tab. A WCL page reached
        // from a bookmark or a Discord link used to be closed too — along with
        // every WoWProgress tab showing that character.
        const mine   = newTab(WCL_THRALL);
        const wpTab  = newTab(CANDIDATE);
        sendFromTab(mine, { action: 'parseThresholdFailed', warcraftLogsUrl: WCL_THRALL });
        await settle();
        expect(removed).toEqual([]);
        expect(tabs.has(wpTab.id)).toBe(true);
    });

    it('leaves our tab alone after the user navigated it to another character', async () => {
        const wcl = await scoutFrom(newTab(CANDIDATE));
        const jaina = WCL_THRALL.replace('Thrall', 'Jaina');
        wcl.url = jaina;
        sendFromTab(wcl, { action: 'parseThresholdFailed', warcraftLogsUrl: jaina });
        await settle();
        expect(removed).toEqual([]);
    });

    it('forgets a scouted tab when it is closed, so a reused id is not ours', async () => {
        const wcl = await scoutFrom(newTab(CANDIDATE));
        expect(Object.keys(sessionData.scoutedTabs)).toContain(String(wcl.id));
        for (const fn of listeners.onRemoved) fn(wcl.id);
        await settle();
        expect(Object.keys(sessionData.scoutedTabs)).not.toContain(String(wcl.id));
    });

    it('ignores the message from a site outside the allowlist', async () => {
        const wcl = await scoutFrom(newTab(CANDIDATE));
        for (const fn of listeners.onMessage) {
            fn({ action: 'parseThresholdFailed', warcraftLogsUrl: WCL_THRALL },
               { id: 'x', url: 'https://evil.example/', tab: { id: wcl.id, url: 'https://evil.example/' } }, () => {});
        }
        await settle();
        expect(removed).toEqual([]);
    });
});

// ─── Raider.IO openTab ────────────────────────────────────────────────────────

describe('openTab from Raider.IO', () => {
    const RIO = 'https://raider.io/characters/eu/tarren-mill/Thrall';

    function openTab(tab, url) {
        return new Promise(resolve => {
            for (const fn of listeners.onMessage) {
                fn({ action: 'openTab', url }, { id: 'x', url: tab.url, tab }, resolve);
            }
        });
    }

    it('opens the tab and never registers the Raider.IO page for closing', async () => {
        const rio = newTab(RIO);
        const res = await openTab(rio, WCL_THRALL);
        expect(res).toMatchObject({ opened: true });
        const wcl = created.at(-1);
        sendFromTab(wcl, { action: 'parseThresholdFailed', warcraftLogsUrl: WCL_THRALL });
        await settle();
        expect(removed).toEqual([wcl.id]);   // the WCL tab, never raider.io
    });

    it('answers a repeat request with duplicate rather than a second tab', async () => {
        const rio = newTab(RIO);
        await openTab(rio, WCL_THRALL);
        const res = await openTab(rio, WCL_THRALL);
        expect(res).toMatchObject({ opened: false, verdict: 'duplicate' });
        expect(created).toHaveLength(1);
    });

    it('refuses a URL that is not a WarcraftLogs character page', async () => {
        const res = await openTab(newTab(RIO), 'https://evil.example/character/x');
        expect(res).toMatchObject({ opened: false, reason: 'BLOCKED' });
        expect(created).toEqual([]);
    });
});

describe('scouted-tab registry', () => {
    it('keeps every record when several scouts finish at once', async () => {
        const sources = [newTab(CANDIDATE), newTab(CANDIDATE.replace('Thrall', 'Jaina')), newTab(CANDIDATE.replace('Thrall', 'Anduin'))];
        sources.forEach(t => navigate(t));
        await settle();
        await settle();
        expect(created).toHaveLength(3);
        expect(Object.keys(sessionData.scoutedTabs).sort())
            .toEqual(created.map(t => String(t.id)).sort());
    });

    it('acts on a repeated below-threshold report only once', async () => {
        const source = newTab(CANDIDATE);
        navigate(source);
        await settle();
        const wcl = created.at(-1);
        const before = await new Promise(r => listeners.onMessage.at(-1)({ action: 'getClosedTabCount' }, {}, r));
        const msg = { action: 'parseThresholdFailed', warcraftLogsUrl: WCL_THRALL };
        sendFromTab(wcl, msg);
        sendFromTab(wcl, msg);
        await settle();
        await settle();
        const after = await new Promise(r => listeners.onMessage.at(-1)({ action: 'getClosedTabCount' }, {}, r));
        expect(after.count - before.count).toBe(1);
    });
});
