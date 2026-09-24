// tests/background-source-tab.test.js
// Pre-flight scouting closes the WoWProgress tab a rejected candidate was
// opened from — but it decides asynchronously, and the user can navigate that
// tab while the API answers. Closing by tab id alone then closed whatever the
// tab showed by then: the gearscore listing they went back to, or the next
// candidate. closeTabIfStillOn() re-reads the tab before closing it.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

const CANDIDATE = 'https://www.wowprogress.com/character/eu/tarren-mill/Thrall';
const LISTING   = 'https://www.wowprogress.com/gearscore/eu?lfg=1&raids_week=';

let isSameWowProgressCharacter, closeTabIfStillOn;
let tabs, removed;

beforeAll(async () => {
    const noop = () => {};
    const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
    globalThis.chrome = {
        runtime: { id: 'x', getURL: (p = '') => 'chrome-extension://x/' + p, onMessage: { addListener: noop } },
        storage: { local: area, sync: area, session: area },
        action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
        tabs: {
            onRemoved: { addListener: noop },
            query: async () => [],
            get: async id => {
                if (!tabs.has(id)) throw new Error(`No tab with id: ${id}.`);
                return tabs.get(id);
            },
            remove: async id => { removed.push(id); tabs.delete(id); },
        },
        webNavigation: { onCompleted: { addListener: noop } },
    };
    ({ isSameWowProgressCharacter, closeTabIfStillOn } = await import('../src/background.js'));
});

beforeEach(() => {
    tabs = new Map();
    removed = [];
});

describe('closeTabIfStillOn', () => {
    it('closes the tab when it still shows the rejected candidate', async () => {
        tabs.set(5, { id: 5, url: CANDIDATE });
        expect(await closeTabIfStillOn(5, CANDIDATE)).toBe(true);
        expect(removed).toEqual([5]);
    });

    it('leaves the tab alone once the user has gone back to the listing', async () => {
        // The bug: click a name on the listing (same tab), press Back before
        // the API answers, and the listing tab was closed.
        tabs.set(5, { id: 5, url: LISTING });
        expect(await closeTabIfStillOn(5, CANDIDATE)).toBe(false);
        expect(removed).toEqual([]);
    });

    it('leaves the tab alone once the user has moved on to another candidate', async () => {
        tabs.set(5, { id: 5, url: 'https://www.wowprogress.com/character/eu/tarren-mill/Jaina' });
        expect(await closeTabIfStillOn(5, CANDIDATE)).toBe(false);
        expect(removed).toEqual([]);
    });

    it('leaves the tab alone while it is navigating away', async () => {
        tabs.set(5, { id: 5, url: CANDIDATE, pendingUrl: LISTING });
        expect(await closeTabIfStillOn(5, CANDIDATE)).toBe(false);
        expect(removed).toEqual([]);
    });

    it('does nothing when the tab is already gone', async () => {
        expect(await closeTabIfStillOn(5, CANDIDATE)).toBe(false);
        expect(removed).toEqual([]);
    });
});

describe('isSameWowProgressCharacter', () => {
    it('ignores query string, hash and region/realm case', () => {
        expect(isSameWowProgressCharacter(CANDIDATE + '?x=1#gear',
            'https://www.wowprogress.com/character/EU/Tarren-Mill/Thrall')).toBe(true);
    });

    it('treats an encoded and a decoded name as the same character', () => {
        expect(isSameWowProgressCharacter(
            'https://www.wowprogress.com/character/eu/kazzak/Ch%C3%A9',
            'https://www.wowprogress.com/character/eu/kazzak/Ché')).toBe(true);
    });

    it('distinguishes different characters and non-character pages', () => {
        expect(isSameWowProgressCharacter(CANDIDATE, CANDIDATE.replace('Thrall', 'Jaina'))).toBe(false);
        expect(isSameWowProgressCharacter(LISTING, LISTING)).toBe(false);
        expect(isSameWowProgressCharacter('not a url', 'not a url')).toBe(false);
    });
});
