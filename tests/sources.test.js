// tests/sources.test.js
// Tests the adapters that do their own extraction: the WoWProgress fetch path
// (HTML) and the Raider.IO api path (JSON). The remaining tab-mode adapters
// delegate extraction to the live content scripts, so there is no markup here
// to test — their failure mode is covered by the harvest error handling in
// scout.js instead.

import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import {
    parseWowProgressDocument, DEFAULT_SOURCE_URLS, adapterFor,
    raiderIoApiUrl, parseRaiderIoMatches, roleFromProfileRole,
} from '../src/scout/sources.js';
import { normalizeCandidate, mergeCandidates, passesRaiderIoFilters } from '../src/scout/scout-core.js';

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

// ─── Raider.IO: api mode ──────────────────────────────────────────────────────
// Shapes below are trimmed copies of a real /api/search-advanced response.

const apiMatch = (over = {}) => ({
    type: 'character',
    name: over.name ?? 'Stormrayder',
    data: {
        name:   over.name ?? 'Stormrayder',
        realm:  { slug: over.realm ?? 'frostmourne' },
        region: { slug: over.region ?? 'us', short_name: over.shortName ?? 'OC' },
        class:  { slug: over.classSlug ?? 'shaman' },
        spec:   over.spec === null ? null : { name: over.specName ?? 'Elemental', role: over.role ?? 'dps' },
        guild:  over.guild === null ? null : { name: over.guild ?? 'Unphased' },
        itemLevelEquipped: over.ilvl === null ? null : (over.ilvl ?? 311.5),
        thumbnailUrl: over.thumb === null ? null : (over.thumb ?? '//render.worldofwarcraft.com/us/character/a.jpg'),
    },
});

describe('raiderIoApiUrl', () => {
    const listing = 'https://raider.io/search?type=character' +
        '&recruitment.guild_raids.profile.published_at%5B0%5D%5Bgte%5D=1' +
        '&sort%5Brecruitment.guild_raids.profile.published_at%5D=desc';

    it('points at the JSON endpoint, not the page', () => {
        expect(raiderIoApiUrl(listing)).toContain('https://raider.io/api/search-advanced?');
    });

    it('carries the listing filters across verbatim', () => {
        const params = new URL(raiderIoApiUrl(listing)).searchParams;
        expect(params.get('recruitment.guild_raids.profile.published_at[0][gte]')).toBe('1');
        expect(params.get('sort[recruitment.guild_raids.profile.published_at]')).toBe('desc');
    });

    it('forces type=character, which the endpoint needs to honour recruitment filters', () => {
        const bare = 'https://raider.io/search?recruitment.guild_raids.profile.published_at%5B0%5D%5Bgte%5D=1';
        expect(new URL(raiderIoApiUrl(bare)).searchParams.get('type')).toBe('character');
        // ...and does not end up with two of them.
        expect(raiderIoApiUrl(listing).match(/type=/g)).toHaveLength(1);
    });

    it('pages with limit/offset and never exceeds the endpoint ceiling', () => {
        const p = new URL(raiderIoApiUrl(listing, { offset: 200 })).searchParams;
        expect(p.get('offset')).toBe('200');
        expect(p.get('limit')).toBe('100');
        expect(new URL(raiderIoApiUrl(listing, { limit: 5000 })).searchParams.get('limit')).toBe('100');
    });
});

describe('parseRaiderIoMatches', () => {
    it('reads identity, class, role and ilvl from one match', () => {
        const [row] = parseRaiderIoMatches({ matches: [apiMatch()] });
        expect(row).toMatchObject({
            name: 'Stormrayder', realm: 'frostmourne', region: 'us',
            playerClass: 'shaman', role: 'dps', ilvl: 311.5,
            spec: 'Elemental', guild: 'Unphased', inGuild: true,
        });
    });

    it('normalises the API hyphenated class slugs to the extension keys', () => {
        const rows = parseRaiderIoMatches({ matches: [
            apiMatch({ classSlug: 'death-knight' }),
            apiMatch({ classSlug: 'demon-hunter' }),
            apiMatch({ classSlug: 'evoker' }),
        ] });
        expect(rows.map(r => r.playerClass)).toEqual(['deathknight', 'demon_hunter', 'evoker']);
    });

    it('takes region from region.slug, never the display short_name', () => {
        // short_name is display text and varies wildly: 'OC', 'EU EN', 'US ES'.
        const [row] = parseRaiderIoMatches({ matches: [apiMatch({ region: 'us', shortName: 'OC' })] });
        expect(row.region).toBe('us');
    });

    it('absolutises the protocol-relative avatar URL', () => {
        const [row] = parseRaiderIoMatches({ matches: [apiMatch()] });
        expect(row.avatar).toBe('https://render.worldofwarcraft.com/us/character/a.jpg');
    });

    it('skips matches with no usable identity rather than emitting a partial row', () => {
        const rows = parseRaiderIoMatches({ matches: [
            apiMatch(),
            { data: { name: 'Nameless', realm: null, region: { slug: 'eu' } } },
            { data: { realm: { slug: 'x' }, region: { slug: 'eu' } } },
            {},
        ] });
        expect(rows).toHaveLength(1);
    });

    it('survives an empty or malformed payload', () => {
        expect(parseRaiderIoMatches(null)).toEqual([]);
        expect(parseRaiderIoMatches({})).toEqual([]);
        expect(parseRaiderIoMatches({ matches: [] })).toEqual([]);
    });

    it('produces rows that normalise into valid candidates', () => {
        const rows = parseRaiderIoMatches({ matches: [apiMatch()] });
        const candidate = normalizeCandidate(rows[0], 'raiderio');
        expect(candidate.key).toBe('us/frostmourne/stormrayder');
        expect(candidate.avatar).toContain('render.worldofwarcraft.com');
    });
});

describe('passesRaiderIoFilters', () => {
    const cand = (over = {}) => normalizeCandidate(
        parseRaiderIoMatches({ matches: [apiMatch(over)] })[0], 'raiderio');

    it('keeps everything when no filter is set', () => {
        expect(passesRaiderIoFilters(cand(), {})).toBe(true);
    });

    it('filters by region, role, class and minimum ilvl', () => {
        expect(passesRaiderIoFilters(cand(), { selectedRegions: ['eu'] })).toBe(false);
        expect(passesRaiderIoFilters(cand(), { selectedRegions: ['us'] })).toBe(true);
        expect(passesRaiderIoFilters(cand(), { selectedRoles: ['healer'] })).toBe(false);
        expect(passesRaiderIoFilters(cand(), { selectedRoles: ['dps'] })).toBe(true);
        expect(passesRaiderIoFilters(cand(), { selectedClasses: ['mage'] })).toBe(false);
        expect(passesRaiderIoFilters(cand(), { selectedClasses: ['shaman'] })).toBe(true);
        expect(passesRaiderIoFilters(cand(), { minIlvl: 320 })).toBe(false);
        expect(passesRaiderIoFilters(cand(), { minIlvl: 300 })).toBe(true);
    });

    it('fails open on unknown values rather than dropping the lead', () => {
        // Same contract as passesWowProgressFilters: only exclude on a value we
        // actually know. Losing a candidate to missing data is the worse error.
        expect(passesRaiderIoFilters(cand({ ilvl: null }), { minIlvl: 320 })).toBe(true);
        expect(passesRaiderIoFilters(cand({ spec: null }), { selectedRoles: ['tank'] })).toBe(true);
    });

    it('rejects a null candidate', () => {
        expect(passesRaiderIoFilters(null, {})).toBe(false);
    });
});

describe('adapter registry', () => {
    it('reads Raider.IO through its API, with no tab', () => {
        expect(adapterFor('raiderio').mode).toBe('api');
        expect(adapterFor('raiderio').supportsPagination).toBe(true);
    });

    it('still routes the Cloudflare-gated and human-gated listings via a tab', () => {
        expect(adapterFor('guildsofwow').mode).toBe('tab');
        expect(adapterFor('warcraftlogs').mode).toBe('tab');
    });

    it('keeps type=character in the default Raider.IO listing URL', () => {
        expect(new URL(DEFAULT_SOURCE_URLS.raiderio).searchParams.get('type')).toBe('character');
    });
});

// ─── roleFromProfileRole ──────────────────────────────────────────────────────
// Raider.IO's character-profile endpoint words the role differently from its
// search endpoint: TANK / HEALING / DPS rather than tank / healer / dps. The
// "HEALING" → "healer" step is the one that matters — getting it wrong would
// leave every enriched healer scored on the DPS metric, which is the exact bug
// role enrichment exists to fix.

describe('roleFromProfileRole', () => {
    it('maps the profile endpoint vocabulary to the extension\'s own', () => {
        expect(roleFromProfileRole('TANK')).toBe('tank');
        expect(roleFromProfileRole('HEALING')).toBe('healer');
        expect(roleFromProfileRole('DPS')).toBe('dps');
    });

    it('is case- and whitespace-insensitive', () => {
        expect(roleFromProfileRole('healing')).toBe('healer');
        expect(roleFromProfileRole('  Tank  ')).toBe('tank');
    });

    it('returns null for anything it does not recognise', () => {
        // Fail open: a null leaves the candidate exactly as it was.
        for (const value of ['', '   ', 'HEALER', 'SUPPORT', 'nonsense', null, undefined, 0]) {
            expect(roleFromProfileRole(value), String(value)).toBe(null);
        }
    });

    it('does not accept "HEALER", which is the extension\'s word, not the API\'s', () => {
        // Guards against someone "tidying" the map to the internal vocabulary
        // and silently breaking every healer lookup.
        expect(roleFromProfileRole('HEALER')).toBe(null);
        expect(roleFromProfileRole('HEALING')).toBe('healer');
    });
});
