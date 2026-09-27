/**
 * Fixture data for the Scout documentation screenshots.
 *
 * The Scout page is driven through its real code path — the WoWProgress fetch
 * adapter, the Raider.IO cross-reference and the scoring pipeline all run as
 * they would in the browser — with only the three network calls stubbed. That
 * means a screenshot cannot show a layout the code cannot actually produce.
 *
 * Kept out of screenshots.mjs because it is data, not procedure, and because it
 * is the part anyone updating the shots will actually want to edit.
 *
 * Names are invented. Realms are real, because realm names are what make the
 * de-duplication in the table legible.
 */

// spec drives the role (roleForSpec), so tanks/healers/DPS in the table are
// resolved the same way a live run resolves them.
// `diff` is the raid difficulty WarcraftLogs ranked them at (5 mythic, 4 heroic)
// — heroic-only raiders deliberately carry *higher* percentages than the mythic
// ones, so the shot shows the parse sort grouping mythic first rather than
// mixing the two on one scale. `listed` is how many days ago they posted.
export const CANDIDATES = [
    { name: 'Thalyndra', realm: 'Tarren Mill',     cls: 'druid',        spec: 'Restoration',   ilvl: 322.1, mplus: 3104, kills: 6, diff: 5, best: 81, median: 72, listed: 1,  alsoOn: ['raiderio', 'guildsofwow'] },
    { name: 'Morvath',   realm: 'Draenor',         cls: 'deathknight',  spec: 'Blood',         ilvl: 320.6, mplus: 2870, kills: 8, diff: 5, best: 78, median: 66, listed: 9 },
    { name: 'Silvaraen', realm: 'Kazzak',          cls: 'evoker',       spec: 'Devastation',   ilvl: 321.4, mplus: 3011, kills: 6, diff: 5, best: 74, median: 63, listed: 3,  alsoOn: ['raiderio'] },
    { name: 'Halgrimm',  realm: 'Stormscale',      cls: 'paladin',      spec: 'Protection',    ilvl: 321.9, mplus: 2610, kills: 7, diff: 5, best: 70, median: 58, listed: 21 },
    { name: 'Okthiri',   realm: 'Ragnaros',        cls: 'monk',         spec: 'Mistweaver',    ilvl: 320.0, mplus: 2955, kills: 6, diff: 5, best: 69, median: 57, listed: 5,  alsoOn: ['guildsofwow'] },
    { name: 'Vexanya',   realm: 'Silvermoon',      cls: 'demon_hunter', spec: 'Havoc',         ilvl: 318.8, mplus: 2820, kills: 0, diff: 4, best: 95, median: 91, listed: 2 },
    { name: 'Duskerin',  realm: 'Argent Dawn',     cls: 'rogue',        spec: 'Assassination', ilvl: 317.5, mplus: 2690, kills: 0, diff: 4, best: 92, median: 86, listed: 0.3, alsoOn: ['raiderio'] },
    { name: 'Brenndar',  realm: 'Twisting Nether', cls: 'warrior',      spec: 'Fury',          ilvl: 319.3, mplus: 2744, kills: 0, diff: 4, best: 88, median: 80, listed: 14 },
    { name: 'Torvahl',   realm: 'Antonidas',       cls: 'shaman',       spec: 'Elemental',     ilvl: 318.1, mplus: 2733, kills: 0, diff: 4, best: 84, median: 76, listed: 40 },
    { name: 'Nyxaris',   realm: 'Ravencrest',      cls: 'mage',         spec: 'Frost',         ilvl: 316.4, mplus: 2588, kills: 0, diff: 4, best: 79, median: 70, listed: 7 },
    // Below the stubbed thresholds, so the "N below thresholds" counter in the
    // toolbar is showing a real number rather than a decorative one.
    { name: 'Grumbald',  realm: 'Blackmoore',      cls: 'hunter',       spec: 'Marksmanship',  ilvl: 314.2, mplus: 2401, kills: 0, diff: 4, best: 44, median: 38, listed: 4 },
    { name: 'Pellonir',  realm: 'Kil’jaeden', cls: 'priest',       spec: 'Discipline',    ilvl: 315.0, mplus: 2470, kills: 0, diff: 4, best: 41, median: 33, listed: 6 },
];

/**
 * The instant the screenshots are taken at. The page's Date.now is pinned to it
 * so "3d ago" in the Listed column renders identically on every run — the
 * output stays byte-stable (quirk 38).
 */
export const FIXTURE_NOW = Date.UTC(2026, 8, 27, 12, 0, 0);
const listedTs = (c) => Math.round((FIXTURE_NOW - c.listed * 24 * 60 * 60 * 1000) / 1000);

/**
 * The rows a tab-mode source (Raider.IO, Guilds of WoW) hands back from its
 * content script's harvester. Only the cross-posted candidates appear, so the
 * "Advertising on" column in the screenshot shows what it is actually for: the
 * same player advertising in more than one place.
 */
export function tabHarvest(sourceId) {
    return CANDIDATES
        .filter(c => (c.alsoOn || []).includes(sourceId))
        .map(c => ({
            name: c.name, realm: c.realm, region: 'eu',
            playerClass: c.cls, role: null,
            ilvl: c.ilvl,
            // Guilds of WoW publishes a mythic kill count but no boss total —
            // the case that makes formatMythicProgress fall back to a bare number
            // until the Raider.IO cross-reference supplies the denominator.
            mythicKills: sourceId === 'guildsofwow' ? c.kills : null,
            listed: listedTs(c),
            link: sourceId === 'raiderio'
                ? `https://raider.io/characters/eu/${c.realm.toLowerCase().replace(/[' ]/g, '-')}/${c.name}`
                : null,
        }));
}

/** The current tier's boss count — what turns "6" into "6/8" in the Mythic column. */
export const TIER_BOSSES = 8;

const CLASS_DISPLAY = {
    deathknight: 'Death Knight', demon_hunter: 'Demon Hunter',
};
const display = (cls) => CLASS_DISPLAY[cls] || cls[0].toUpperCase() + cls.slice(1);

/**
 * A WoWProgress /gearscore/ listing, in the markup parseWowProgressDocument()
 * reads: a .rating table whose rows carry the class on .character, the item
 * level in td.center, and a /character/<region>/<realm>/<name> link.
 */
export function wowprogressListingHtml() {
    const rows = CANDIDATES.map(c => `
        <tr>
            <td class="character ${c.cls}">
                <a href="/character/eu/${encodeURIComponent(c.realm)}/${c.name}">${c.name}</a>
                <span class="realm">${c.realm}</span>
            </td>
            <td class="center">${c.ilvl.toFixed(2)}</td>
            <td></td>
            <td><span class="datetime" data-ts="${listedTs(c)}"></span></td>
        </tr>`).join('');

    return `<!doctype html><html><head><title>WoWProgress: Gear Score Rating</title></head><body>
        <div class="ratingContainer"><table class="rating">
            <tr><th>Character</th><th>Gear Score</th><th>Guild</th></tr>${rows}
        </table></div></body></html>`;
}

/** A Raider.IO character profile, in the shape enrich.js reads. */
export function raiderioProfile(name) {
    const c = CANDIDATES.find(x => x.name.toLowerCase() === String(name).toLowerCase());
    if (!c) return null;
    return {
        name: c.name,
        class: display(c.cls),
        active_spec_name: c.spec,
        active_spec_role: 'DPS',          // roleForSpec(spec) takes precedence
        gear: { item_level_equipped: c.ilvl },
        mythic_plus_scores_by_season: [{ season: 'season-mn-2', scores: { all: c.mplus } }],
        raid_progression: {
            'the-tidebound-grotto': { expansion_id: 11, total_bosses: 1, mythic_bosses_killed: 1 },
            'the-venomous-abyss':   { expansion_id: 11, total_bosses: TIER_BOSSES, mythic_bosses_killed: c.kills },
            'tier-mn-1':            { expansion_id: 11, total_bosses: 9, mythic_bosses_killed: c.kills + 1 },
        },
    };
}

/** A WarcraftLogs score, in the shape getCharacterScore() returns. */
export function wclScore(character) {
    const c = CANDIDATES.find(x => x.name.toLowerCase() === String(character?.name).toLowerCase());
    if (!c) return { best: null, median: null, notFound: true };
    return { best: c.best, median: c.median, notFound: false, spec: c.spec, role: roleForSpec(c.spec), difficulty: c.diff };
}

// Mirrors roleForSpec() in content/common.js — the fixture cannot import a
// classic script, and a screenshot showing a Mistweaver as DPS would be wrong.
const HEALER_SPECS = new Set(['restoration', 'holy', 'discipline', 'mistweaver', 'preservation']);
const TANK_SPECS   = new Set(['protection', 'guardian', 'blood', 'brewmaster', 'vengeance']);
function roleForSpec(spec) {
    const s = String(spec).toLowerCase();
    if (HEALER_SPECS.has(s)) return 'healer';
    if (TANK_SPECS.has(s))   return 'tank';
    return 'dps';
}
