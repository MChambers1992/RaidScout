// tests/sources.test.js
// Tests the one adapter that parses markup itself: the WoWProgress fetch path.
// The tab-mode adapters delegate extraction to the live content scripts, so
// there is no markup here to test — their failure mode is covered by the
// harvest error handling in scout.js instead.

import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { parseWowProgressDocument, DEFAULT_SOURCE_URLS, adapterFor } from '../src/scout/sources.js';
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
