// tests/background-senders.test.js
// The service worker's sender validation, which decides whether a message is
// acted on at all.
//
// This is worth its own suite because its failure is silent and total: a check
// that wrongly rejects does not throw or log, it just answers UNTRUSTED_SENDER
// to every request. That is exactly what happened — isExtensionPageSender
// required sender.tab to be absent, Chrome populates sender.tab for anything
// sent from a tab, and the Scout page is opened with chrome.tabs.create, so
// every score Scout ever asked for was refused and every candidate rendered a
// "⚠ WCL err" badge.
//
// background.js registers its listeners at import time, so `chrome` is stubbed
// before importing it — the same approach tests/wcl-api.test.js uses.

import { describe, it, expect, beforeAll } from 'vitest';

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const ORIGIN = `chrome-extension://${EXTENSION_ID}/`;

let isTrustedTabSender, isExtensionPageSender, isTrustedSender;

beforeAll(async () => {
    const noop = () => {};
    const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
    globalThis.chrome = {
        runtime: {
            id: EXTENSION_ID,
            getURL: (path = '') => ORIGIN + path,
            onMessage: { addListener: noop },
        },
        storage: { local: area, sync: area, session: area },
        action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
        tabs: { onRemoved: { addListener: noop }, query: async () => [] },
        webNavigation: { onCompleted: { addListener: noop } },
    };
    ({ isTrustedTabSender, isExtensionPageSender, isTrustedSender } =
        await import('../src/background.js'));
});

// A sender as Chrome actually shapes it for an extension page in a tab: it has
// BOTH an extension URL and a tab, which is the case the old guard got wrong.
const scoutPageSender = (over = {}) => ({
    id: EXTENSION_ID,
    url: `${ORIGIN}src/scout/scout.html`,
    tab: { id: 7, url: `${ORIGIN}src/scout/scout.html` },
    ...over,
});

const contentScriptSender = (host) => ({
    id: EXTENSION_ID,
    url: `https://${host}/some/page`,
    tab: { id: 3, url: `https://${host}/some/page` },
});

describe('isExtensionPageSender', () => {
    it('accepts the Scout page even though it has a tab', () => {
        // The regression this whole file exists for.
        expect(isExtensionPageSender(scoutPageSender())).toBe(true);
    });

    it('accepts an extension page with no tab, such as the popup', () => {
        expect(isExtensionPageSender({
            id: EXTENSION_ID, url: `${ORIGIN}src/popup/popup.html`,
        })).toBe(true);
    });

    it('rejects a message from another extension', () => {
        // sender.id is set by the browser, so this is the check that keeps a
        // second extension from borrowing our API credentials.
        expect(isExtensionPageSender(scoutPageSender({ id: 'someotherextensionid' }))).toBe(false);
    });

    it('rejects a web page, including the recruitment sites', () => {
        expect(isExtensionPageSender(contentScriptSender('raider.io'))).toBe(false);
        expect(isExtensionPageSender(contentScriptSender('evil.example'))).toBe(false);
    });

    it('rejects a URL that merely mentions the extension origin', () => {
        // startsWith, not includes: a page at https://evil.example/?x=chrome-extension://…
        // must not pass.
        expect(isExtensionPageSender({
            id: EXTENSION_ID, url: `https://evil.example/?next=${ORIGIN}src/scout/scout.html`,
        })).toBe(false);
    });

    it('rejects a sender with no URL at all', () => {
        expect(isExtensionPageSender({ id: EXTENSION_ID })).toBe(false);
        expect(isExtensionPageSender(null)).toBe(false);
    });
});

describe('isTrustedTabSender', () => {
    it('accepts the recruitment sites the extension runs on', () => {
        for (const host of ['www.wowprogress.com', 'raider.io', 'www.warcraftlogs.com',
                            'guildsofwow.com', 'www.guildsofwow.com']) {
            expect(isTrustedTabSender(contentScriptSender(host))).toBe(true);
        }
    });

    it('rejects any other host, including lookalikes', () => {
        for (const host of ['raider.io.evil.example', 'evil.example', 'notraider.io']) {
            expect(isTrustedTabSender(contentScriptSender(host))).toBe(false);
        }
    });

    it('rejects the Scout page, so an extension page can never trigger a tab action', () => {
        // This is what actually keeps the two apart: the sync listener that
        // closes and opens tabs checks isTrustedTabSender alone, so widening
        // isExtensionPageSender granted the Scout page no tab-bound power.
        expect(isTrustedTabSender(scoutPageSender())).toBe(false);
    });

    it('rejects a sender with no tab', () => {
        expect(isTrustedTabSender({ id: EXTENSION_ID, url: 'https://raider.io/x' })).toBe(false);
    });
});

describe('isTrustedSender', () => {
    it('accepts both the recruitment sites and our own pages', () => {
        expect(isTrustedSender(contentScriptSender('raider.io'))).toBe(true);
        expect(isTrustedSender(scoutPageSender())).toBe(true);
    });

    it('rejects everything else', () => {
        expect(isTrustedSender(contentScriptSender('evil.example'))).toBe(false);
        expect(isTrustedSender({})).toBe(false);
    });
});
