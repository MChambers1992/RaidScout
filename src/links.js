// links.js — external links shown in the extension UI.
//
// Single source of truth, loaded as a classic script by the popup, the options
// page and the Scout page (the Scout module reads it off the global scope).
// Change a URL here and every surface follows.
//
// These are plain anchors opened in a new tab: no remote script, no tracking
// pixel, no network request from the extension itself. That keeps RaidScout's
// CSP untouched and its "nothing leaves your machine" property intact.

const RAIDSCOUT_LINKS = {
    donate:  'https://tinyurl.com/donatetochambers',
    youtube: 'https://tinyurl.com/subtochambers',
};

// Fills in any support links present on the current page. Each surface just
// declares <a id="linkDonate"> / <a id="linkYoutube"> and this sets the href,
// so a URL change never has to be made in more than one file.
function applyRaidScoutLinks() {
    const targets = {
        linkDonate:  RAIDSCOUT_LINKS.donate,
        linkYoutube: RAIDSCOUT_LINKS.youtube,
    };
    for (const [id, url] of Object.entries(targets)) {
        const el = document.getElementById(id);
        if (el) el.href = url;
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyRaidScoutLinks);
} else {
    applyRaidScoutLinks();
}
