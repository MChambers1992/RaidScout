// tests/settings-schema.test.js
// The settings schema is the single source of truth for every sync key, and it
// fails quietly: collectFromDom() writes entry.default whenever getElementById
// misses, so a renamed input silently wipes that setting on the next Save
// rather than erroring. These tests bind the schema to the real options.html so
// that mismatch is caught here instead of in a user's storage.
//
// settings-schema.js is a classic script with no exports (options.html loads it
// before options.js), so it is evaluated into a jsdom window — the same approach
// tests/links.test.js uses. Its top-level `const`s are not window properties, so
// a trailing assignment hands them out.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const schemaSource  = readFileSync(new URL('../src/options/settings-schema.js', import.meta.url), 'utf8');
const optionsHtml   = readFileSync(new URL('../src/options/options.html', import.meta.url), 'utf8');

const EXPOSED = ['SCHEMA', 'LEGACY_KEYS', 'ALL_KEYS', 'DEFAULTS',
                 'parseValue', 'loadFromData', 'collectFromDom', 'migrateLegacy'];

// Evaluates the schema against a page and returns its internals plus the document.
function loadSchema(html = optionsHtml) {
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    dom.window.eval(`${schemaSource}\n;window.__api = { ${EXPOSED.join(', ')} };`);
    return { ...dom.window.__api, document: dom.window.document, window: dom.window };
}

describe('schema ↔ options.html wiring', () => {
    it('every element-backed entry points at an id that exists', () => {
        const { SCHEMA, document } = loadSchema();
        const missing = SCHEMA
            .filter(entry => entry.type !== 'checkboxGroup')
            .filter(entry => !document.getElementById(entry.domId))
            .map(entry => `${entry.key} → #${entry.domId}`);

        // A miss here is not cosmetic: collectFromDom falls back to the default,
        // so Save would overwrite whatever the user had stored.
        expect(missing).toEqual([]);
    });

    it('every checkbox group selector matches something', () => {
        const { SCHEMA, document } = loadSchema();
        const empty = SCHEMA
            .filter(entry => entry.type === 'checkboxGroup')
            .filter(entry => document.querySelectorAll(entry.selector).length === 0)
            .map(entry => `${entry.key} → ${entry.selector}`);

        expect(empty).toEqual([]);
    });

    it('declares no duplicate storage keys', () => {
        const { SCHEMA } = loadSchema();
        const keys = SCHEMA.map(e => e.key);
        expect(keys.length).toBe(new Set(keys).size);
    });
});

describe('load and collect round-trip', () => {
    it('returns the defaults unchanged after a load with nothing stored', () => {
        // The first visit to Full Settings must not rewrite a user's settings
        // into something different from what the extension was already using.
        const { DEFAULTS, loadFromData, collectFromDom } = loadSchema();
        loadFromData({});
        const collected = collectFromDom();

        for (const [key, value] of Object.entries(DEFAULTS)) {
            expect({ key, value: collected[key] }).toEqual({ key, value });
        }
    });

    it('preserves stored values through a load and collect', () => {
        const { loadFromData, collectFromDom } = loadSchema();
        const stored = {
            parseThreshold: 75,
            bestParseThreshold: 90,
            wclClientId: 'abc123',
            wclCacheTtlHours: 2.5,
            warcraftlogsEnabled: false,
            wclSelectedClasses: ['mage', 'druid'],
        };
        loadFromData(stored);
        const collected = collectFromDom();

        expect(collected.parseThreshold).toBe(75);
        expect(collected.bestParseThreshold).toBe(90);
        expect(collected.wclClientId).toBe('abc123');
        expect(collected.wclCacheTtlHours).toBe(2.5);
        expect(collected.warcraftlogsEnabled).toBe(false);
        expect(collected.wclSelectedClasses.sort()).toEqual(['druid', 'mage']);
    });

    it('reads a checkbox group back as the ticked values only', () => {
        const { loadFromData, collectFromDom } = loadSchema();
        loadFromData({ wclSelectedRegions: ['EU'] });
        expect(collectFromDom().wclSelectedRegions).toEqual(['EU']);
    });
});

describe('legacy key migration', () => {
    it('fetches the superseded keys so their values can be read at all', () => {
        const { ALL_KEYS, LEGACY_KEYS } = loadSchema();
        // chrome.storage.sync.get(ALL_KEYS) is the only read; a key absent from
        // this list is invisible to the migration no matter what it holds.
        for (const key of LEGACY_KEYS) expect(ALL_KEYS).toContain(key);
    });

    it('carries any per-site sort toggle into the shared key', () => {
        const { migrateLegacy } = loadSchema();
        for (const legacy of ['wpWclSort', 'rioWclSort', 'gowWclSort']) {
            expect(migrateLegacy({ [legacy]: true }).wclSortByParse).toBe(true);
        }
    });

    it('leaves an explicit choice alone in both directions', () => {
        const { migrateLegacy } = loadSchema();
        expect(migrateLegacy({ wclSortByParse: false, wpWclSort: true }).wclSortByParse).toBe(false);
        expect(migrateLegacy({ wclSortByParse: true,  wpWclSort: false }).wclSortByParse).toBe(true);
    });

    it('adds nothing when no legacy toggle was ever set', () => {
        const { migrateLegacy } = loadSchema();
        expect(migrateLegacy({}).wclSortByParse).toBeUndefined();
    });

    it('survives the first Save on an install that had sorting on', () => {
        // The regression this exists for: without seeding, the checkbox shows
        // the schema default (off) and Save writes false, ending the migration
        // for exactly the installs it was written for — without the user ever
        // touching that setting.
        const { loadFromData, collectFromDom } = loadSchema();
        loadFromData({ rioWclSort: true });
        expect(collectFromDom().wclSortByParse).toBe(true);
    });

    it('does not write the superseded keys back to storage', () => {
        const { loadFromData, collectFromDom, LEGACY_KEYS } = loadSchema();
        loadFromData({ wpWclSort: true });
        const collected = collectFromDom();
        for (const key of LEGACY_KEYS) expect(collected).not.toHaveProperty(key);
    });
});

describe('parseValue', () => {
    it('falls back to the default for unparseable numbers', () => {
        const { parseValue } = loadSchema();
        expect(parseValue({ type: 'int', default: 50 }, '')).toBe(50);
        expect(parseValue({ type: 'int', default: 50 }, 'abc')).toBe(50);
        expect(parseValue({ type: 'float', default: 6 }, '')).toBe(6);
    });

    it('keeps a real zero rather than treating it as absent', () => {
        // 0 means "no minimum" for most thresholds, so it has to survive.
        const { parseValue } = loadSchema();
        expect(parseValue({ type: 'int', default: 0 }, '0')).toBe(0);
    });

    it('coerces booleans and passes strings through', () => {
        const { parseValue } = loadSchema();
        expect(parseValue({ type: 'bool', default: false }, true)).toBe(true);
        expect(parseValue({ type: 'string', default: '' }, 'hello')).toBe('hello');
    });
});
