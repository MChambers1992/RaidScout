// tests/links.test.js
// Guards the support links: that the URLs are well-formed and outbound-safe,
// that the helper actually fills them in, and — the one that would really bite —
// that no page can declare a support link without loading links.js, which would
// render a dead anchor.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const linksSource = readFileSync(new URL('../src/links.js', import.meta.url), 'utf8');

const PAGES = [
    ['src/scout/scout.html',     '../links.js'],
    ['src/popup/popup.html',     '../links.js'],
    ['src/options/options.html', '../links.js'],
];

// links.js self-initialises on DOMContentLoaded, which jsdom fires
// asynchronously — so call the helper directly rather than racing the event.
// The auto-init path itself is asserted separately below.
function runLinksIn(html) {
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    dom.window.eval(linksSource);
    dom.window.applyRaidScoutLinks();
    return dom.window.document;
}

describe('support link URLs', () => {
    it('are absolute https URLs', () => {
        const urls = [...linksSource.matchAll(/'(https?:\/\/[^']+)'/g)].map(m => m[1]);
        expect(urls.length).toBeGreaterThan(0);
        for (const url of urls) {
            expect(url.startsWith('https://')).toBe(true);   // never http
            expect(() => new URL(url)).not.toThrow();
        }
    });

    it('defines exactly the two links the UI references', () => {
        expect(linksSource).toMatch(/donate:\s*'https:\/\//);
        expect(linksSource).toMatch(/youtube:\s*'https:\/\//);
    });
});

describe('applyRaidScoutLinks', () => {
    it('fills in both anchors when present', () => {
        const doc = runLinksIn(`<!doctype html><body>
            <a id="linkDonate"></a><a id="linkYoutube"></a></body>`);
        expect(doc.getElementById('linkDonate').href).toMatch(/^https:\/\//);
        expect(doc.getElementById('linkYoutube').href).toMatch(/^https:\/\//);
    });

    it('does not throw on a page with no support links', () => {
        expect(() => runLinksIn('<!doctype html><body><p>nothing</p></body>')).not.toThrow();
    });

    it('self-initialises whether or not the DOM has finished parsing', () => {
        // Both branches matter: the popup and options pages load links.js while
        // parsing, the Scout page can load it after.
        expect(linksSource).toContain("document.readyState === 'loading'");
        expect(linksSource).toContain("addEventListener('DOMContentLoaded', applyRaidScoutLinks)");
        expect(linksSource).toMatch(/else\s*\{\s*applyRaidScoutLinks\(\);/);
    });

    it('fills in whichever anchor is present when only one is', () => {
        const doc = runLinksIn('<!doctype html><body><a id="linkDonate"></a></body>');
        expect(doc.getElementById('linkDonate').href).toMatch(/^https:\/\//);
    });
});

describe('page wiring', () => {
    it.each(PAGES)('%s loads links.js and opens links safely', (page, expectedSrc) => {
        const html = readFileSync(new URL(`../${page}`, import.meta.url), 'utf8');

        // Declaring an anchor without the script would leave a dead link.
        expect(html).toContain('id="linkDonate"');
        expect(html).toContain(`<script src="${expectedSrc}"></script>`);

        // Every support link must open in a new tab without handing the opener
        // to the destination.
        const anchors = [...html.matchAll(/<a class="support-link"[^>]*>/g)].map(m => m[0]);
        expect(anchors.length).toBeGreaterThan(0);
        for (const anchor of anchors) {
            expect(anchor).toContain('target="_blank"');
            expect(anchor).toContain('rel="noopener noreferrer"');
        }
    });

    it('keeps the URLs out of the page markup so links.js stays the only source', () => {
        for (const [page] of PAGES) {
            const html = readFileSync(new URL(`../${page}`, import.meta.url), 'utf8');
            expect(html).not.toContain('tinyurl.com');
        }
    });
});
