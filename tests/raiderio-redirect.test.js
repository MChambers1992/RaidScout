// tests/raiderio-redirect.test.js
// Raider.IO character page → WarcraftLogs tab, driven through the real content
// scripts in jsdom (common.js first, per the manifest).
//
// Raider.IO is a single-page app: going from one character to the next is a
// client-side route change and the content script keeps running. It used to
// guard the request with a plain boolean, so the first character of a session
// got a WarcraftLogs tab and every later one silently did not.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const commonSource   = readFileSync(new URL('../src/content/common.js', import.meta.url), 'utf8');
const raiderioSource = readFileSync(new URL('../src/content/raiderio.js', import.meta.url), 'utf8');

const THRALL = 'https://raider.io/characters/eu/tarren-mill/Thrall';
const JAINA  = 'https://raider.io/characters/eu/tarren-mill/Jaina';

function bootPage(url, stored = {}) {
    const dom = new JSDOM('<!doctype html><head></head><body><main></main></body>', {
        url, runScripts: 'outside-only', pretendToBeVisual: true,
    });
    const sent = [];
    dom.window.chrome = {
        storage: {
            sync: { get: (keys, cb) => cb({ ...stored }) },
            onChanged: { addListener: () => {} },
        },
        runtime: {
            sendMessage: (msg, cb) => { sent.push(msg); cb?.({ opened: true, verdict: 'unknown' }); },
            onMessage: { addListener: () => {} },
            lastError: null,
        },
    };
    dom.window.eval(`${commonSource}\n${raiderioSource}`);
    return { dom, sent };
}

// A client-side route change: new URL, and the app re-renders.
async function spaNavigate(dom, url) {
    dom.window.history.pushState({}, '', url);
    dom.window.document.querySelector('main').appendChild(dom.window.document.createElement('div'));
    await vi.advanceTimersByTimeAsync(1000);
}

const openTabs = sent => sent.filter(m => m.action === 'openTab').map(m => m.url);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('Raider.IO → WarcraftLogs', () => {
    it('asks for a WarcraftLogs tab on a character page', async () => {
        const { sent } = bootPage(THRALL);
        await vi.advanceTimersByTimeAsync(1000);
        expect(openTabs(sent)).toEqual(['https://www.warcraftlogs.com/character/eu/tarren-mill/Thrall']);
    });

    it('asks again for the next character reached without a page load', async () => {
        const { dom, sent } = bootPage(THRALL);
        await vi.advanceTimersByTimeAsync(1000);
        await spaNavigate(dom, JAINA);
        expect(openTabs(sent)).toEqual([
            'https://www.warcraftlogs.com/character/eu/tarren-mill/Thrall',
            'https://www.warcraftlogs.com/character/eu/tarren-mill/Jaina',
        ]);
    });

    it('does not ask twice while the same character re-renders, or on its sub-pages', async () => {
        const { dom, sent } = bootPage(THRALL);
        await vi.advanceTimersByTimeAsync(1000);
        await spaNavigate(dom, THRALL);
        await spaNavigate(dom, THRALL + '/mythic-plus');
        expect(openTabs(sent)).toHaveLength(1);
    });

    it('respects the setting being switched off', async () => {
        const { sent } = bootPage(THRALL, { openWarcraftLogsFromRaiderIO: false });
        await vi.advanceTimersByTimeAsync(1000);
        expect(openTabs(sent)).toEqual([]);
    });
});

describe('Raider.IO ad hiding', () => {
    const adStyle = dom => [...dom.window.document.querySelectorAll('style')]
        .some(s => s.textContent.includes('.advertisement'));

    it('is on for an install that never saved the setting, matching its checkbox', () => {
        const { dom } = bootPage(THRALL);
        expect(adStyle(dom)).toBe(true);
    });

    it('stays off once the user unticks it', () => {
        const { dom } = bootPage(THRALL, { hideRaiderIoAds: false });
        expect(adStyle(dom)).toBe(false);
    });
});
