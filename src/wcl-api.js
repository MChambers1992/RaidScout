// wcl-api.js
// WarcraftLogs API v2 client for the background service worker.
//
// Changes from v1:
//  - Role-aware metric: passes character role so healers get hps, tanks get dps
//  - Role auto-resolution: role 'auto' asks for dps + hps in one query and picks
//    the right one from the spec WarcraftLogs ranked the character as. This is
//    what lets the scout flow decide about a character without opening a page.
//  - AbortController timeout (10 s) on every fetch to prevent hung requests
//  - Rate-limit backoff: reads Retry-After header, stores cooldown in storage.local
//  - Cloudflare challenge detection: a challenged request is reported as
//    CLOUDFLARE_BLOCKED with its own cooldown rather than a generic HTTP error
//  - Credential secret moved to storage.local (not synced across devices)
//  - Debug logging toggle via wclDebug storage key
//  - configurable cache TTL via wclCacheTtlHours storage key (default 6)

import { roleForSpec } from './preflight.js';

const WCL_TOKEN_URL  = 'https://www.warcraftlogs.com/oauth/token';
const WCL_CLIENT_API = 'https://www.warcraftlogs.com/api/v2/client';
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_PREFIX   = 'wclScore:';
const FETCH_TIMEOUT_MS = 10_000;
// How long to stop hitting the API after Cloudflare challenges a request.
// Retrying immediately only deepens the challenge; the user has to load
// warcraftlogs.com in a tab to clear it.
const CLOUDFLARE_COOLDOWN_MS = 5 * 60 * 1000;

let tokenCache = null; // { accessToken, expiresAt }
const inFlight = new Map();

// ─── Debug logging ─────────────────────────────────────────────────────────────

async function isDebugEnabled() {
    const { wclDebug } = await chrome.storage.local.get('wclDebug');
    return !!wclDebug;
}

function dbg(msg, ...args) {
    // Called only after checking isDebugEnabled() in the caller
    console.log(`[RaidScout WCL] ${msg}`, ...args);
}

// ─── Credentials ───────────────────────────────────────────────────────────────
// Client ID lives in sync (not sensitive). Secret lives in local only (never synced).

async function getCredentials() {
    const { wclClientId }     = await chrome.storage.sync.get('wclClientId');
    const { wclClientSecret } = await chrome.storage.local.get('wclClientSecret');
    if (!wclClientId || !wclClientSecret) return null;
    return { clientId: wclClientId.trim(), clientSecret: wclClientSecret.trim() };
}

// Called by background when user saves options — migrates secret from sync→local
// and wipes it from sync so it is never transmitted by Chrome Sync.
async function storeSecret(secret) {
    await chrome.storage.local.set({ wclClientSecret: secret });
    await chrome.storage.sync.remove('wclClientSecret');
}

// ─── Fetch with timeout ────────────────────────────────────────────────────────

async function fetchWithTimeout(url, init, timeoutMs = FETCH_TIMEOUT_MS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: ctrl.signal });
    } catch (err) {
        if (err.name === 'AbortError') throw new Error('FETCH_TIMEOUT');
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

// ─── Rate-limit state ──────────────────────────────────────────────────────────

async function getRateLimitCooldown() {
    const { wclRateLimitUntil } = await chrome.storage.local.get('wclRateLimitUntil');
    return wclRateLimitUntil ? Math.max(0, wclRateLimitUntil - Date.now()) : 0;
}

async function setRateLimitCooldown(retryAfterHeader) {
    const seconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 60;
    const until = Date.now() + (isNaN(seconds) ? 60_000 : seconds * 1000);
    await chrome.storage.local.set({ wclRateLimitUntil: until });
}

async function clearRateLimitCooldown() {
    await chrome.storage.local.remove('wclRateLimitUntil');
}

// ─── Cloudflare challenge state ────────────────────────────────────────────────
// WarcraftLogs sits behind Cloudflare. Extension requests normally sail through
// on the bearer token, but a challenged network / VPN / fresh profile gets an
// interstitial instead of JSON. That is not an API error and retrying makes it
// worse, so we detect it, back off, and report it distinctly so the UI can tell
// the user what actually fixes it (load warcraftlogs.com in a tab once).

const CF_BODY_MARKERS = [
    'cf-browser-verification',
    'challenge-platform',
    'cf_chl_opt',
    'just a moment',
    'attention required',
    'enable javascript and cookies to continue',
];

function isCloudflareChallenge(res, bodyText = '') {
    if (res.status !== 403 && res.status !== 503) return false;
    if (res.headers.get('cf-mitigated')) return true;
    const body = bodyText.toLowerCase();
    if (CF_BODY_MARKERS.some(m => body.includes(m))) return true;
    // A Cloudflare-served block page without any of the markers above still
    // carries a cf-ray and is HTML rather than the JSON the API would return.
    const contentType = res.headers.get('content-type') || '';
    return !!res.headers.get('cf-ray') && contentType.includes('text/html');
}

async function getCloudflareCooldown() {
    const { wclCloudflareUntil } = await chrome.storage.local.get('wclCloudflareUntil');
    return wclCloudflareUntil ? Math.max(0, wclCloudflareUntil - Date.now()) : 0;
}

async function setCloudflareCooldown() {
    await chrome.storage.local.set({ wclCloudflareUntil: Date.now() + CLOUDFLARE_COOLDOWN_MS });
}

async function clearCloudflareCooldown() {
    await chrome.storage.local.remove('wclCloudflareUntil');
}

// ─── Token handling ────────────────────────────────────────────────────────────

async function loadPersistedToken() {
    if (tokenCache) return tokenCache;
    const { wclToken } = await chrome.storage.local.get('wclToken');
    if (wclToken && wclToken.expiresAt > Date.now() + 60_000) {
        tokenCache = wclToken;
        return tokenCache;
    }
    return null;
}

async function fetchNewToken(creds) {
    const basic = btoa(`${creds.clientId}:${creds.clientSecret}`);
    const res = await fetchWithTimeout(WCL_TOKEN_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${basic}`,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (isCloudflareChallenge(res, text)) {
            await setCloudflareCooldown();
            throw new Error(`CLOUDFLARE_BLOCKED:${CLOUDFLARE_COOLDOWN_MS / 1000}`);
        }
        throw new Error(`WCL token request failed (${res.status}): ${text.slice(0, 200)}`);
    }

    const json = await res.json();
    const expiresAt = Date.now() + (json.expires_in ? json.expires_in * 1000 : 3_600_000);
    tokenCache = { accessToken: json.access_token, expiresAt };
    await chrome.storage.local.set({ wclToken: tokenCache });
    return tokenCache;
}

async function getAccessToken() {
    const existing = await loadPersistedToken();
    if (existing) return existing.accessToken;
    const creds = await getCredentials();
    if (!creds) throw new Error('NO_CREDENTIALS');
    const fresh = await fetchNewToken(creds);
    return fresh.accessToken;
}

// ─── Role → metric mapping ────────────────────────────────────────────────────
// WCL metric names: dps | hps | tankhps (tank uses dps as primary, hps as secondary)
// We use 'dps' for dps/tank, 'hps' for healer.
// Role 'auto' is special: ask for both and let the ranked spec decide.

function roleToMetric(role) {
    if (role === 'healer') return 'hps';
    return 'dps'; // dps and tank both use DPS metric
}

// ─── GraphQL query ─────────────────────────────────────────────────────────────

// metric 'auto' fetches both metrics in a single request under aliases, so
// resolving a character's role costs one round trip rather than two.
function buildQuery(metric) {
    const rankings = metric === 'auto'
        ? '      dps: zoneRankings(metric: dps)\n      hps: zoneRankings(metric: hps)'
        : `      dps: zoneRankings(metric: ${metric})`;
    return `
query ($name: String!, $serverSlug: String!, $serverRegion: String!) {
  characterData {
    character(name: $name, serverSlug: $serverSlug, serverRegion: $serverRegion) {
${rankings}
    }
  }
}`.trim();
}

function extractScores(zoneRankings) {
    if (!zoneRankings || typeof zoneRankings !== 'object') return { best: null, median: null };
    const best   = typeof zoneRankings.bestPerformanceAverage   === 'number' ? zoneRankings.bestPerformanceAverage   : null;
    const median = typeof zoneRankings.medianPerformanceAverage === 'number' ? zoneRankings.medianPerformanceAverage : null;
    return { best, median };
}

// The zoneRankings blob carries the spec the character ranked as, either on the
// all-stars entries or per encounter. Either is enough to derive their role.
function extractSpec(zoneRankings) {
    if (!zoneRankings || typeof zoneRankings !== 'object') return null;
    const allStar = Array.isArray(zoneRankings.allStars)
        ? zoneRankings.allStars.find(a => a && a.spec)
        : null;
    if (allStar) return allStar.spec;
    const ranking = Array.isArray(zoneRankings.rankings)
        ? zoneRankings.rankings.find(r => r && (r.bestSpec || r.spec))
        : null;
    return ranking ? (ranking.bestSpec || ranking.spec) : null;
}

async function queryCharacter({ name, serverSlug, serverRegion, metric = 'dps', role = 'dps' }, retryOnAuth = true) {
    // Both cooldowns are stored as ms but reported as seconds, matching the
    // Retry-After header the 429 path echoes.
    const cfCooldown = await getCloudflareCooldown();
    if (cfCooldown > 0) throw new Error(`CLOUDFLARE_BLOCKED:${Math.ceil(cfCooldown / 1000)}`);

    const cooldown = await getRateLimitCooldown();
    if (cooldown > 0) throw new Error(`RATE_LIMITED:${Math.ceil(cooldown / 1000)}`);

    const token = await getAccessToken();
    const debug = await isDebugEnabled();
    if (debug) dbg('querying', { name, serverSlug, serverRegion, metric });

    const res = await fetchWithTimeout(WCL_CLIENT_API, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            query: buildQuery(metric),
            variables: { name, serverSlug, serverRegion },
        }),
    });

    if (res.status === 401 && retryOnAuth) {
        tokenCache = null;
        await chrome.storage.local.remove('wclToken');
        return queryCharacter({ name, serverSlug, serverRegion, metric, role }, false);
    }

    if (res.status === 429) {
        const retryAfter = res.headers.get('Retry-After');
        await setRateLimitCooldown(retryAfter);
        throw new Error(`RATE_LIMITED:${retryAfter || '60'}`);
    }

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (isCloudflareChallenge(res, text)) {
            await setCloudflareCooldown();
            if (debug) dbg('cloudflare challenge on API request', { status: res.status });
            throw new Error(`CLOUDFLARE_BLOCKED:${CLOUDFLARE_COOLDOWN_MS / 1000}`);
        }
        throw new Error(`WCL query failed (${res.status})`);
    }

    // Successful response clears any stale backoff flags
    await clearRateLimitCooldown();
    await clearCloudflareCooldown();

    const json = await res.json();
    if (json.errors?.length) throw new Error(`WCL GraphQL error: ${json.errors[0].message}`);

    const character = json?.data?.characterData?.character;
    if (!character) return { best: null, median: null, notFound: true };

    // Resolve role from the ranked spec, then read the scores for the metric
    // that role actually cares about. Only 'auto' lets the spec pick the role —
    // when the caller named a role, its numbers are the ones we returned, so
    // overriding the role here would apply the wrong thresholds to them.
    const spec     = extractSpec(character.dps) || extractSpec(character.hps);
    const specRole = roleForSpec(spec);
    const source   = (metric === 'auto' && specRole === 'healer') ? character.hps : character.dps;
    const resolvedRole = metric === 'auto' ? (specRole || 'dps') : role;

    const scores = extractScores(source);
    if (debug) dbg('scores', { ...scores, spec, role: resolvedRole });
    return { ...scores, notFound: false, spec: spec || null, role: resolvedRole };
}

// ─── Cache ─────────────────────────────────────────────────────────────────────

function characterKey({ region, realm, name, role }) {
    // Include role in the key so DPS/healer caches don't collide on alts
    return `${region}/${realm}/${name}/${role || 'dps'}`.toLowerCase();
}

async function getCacheTtlMs() {
    const { wclCacheTtlHours } = await chrome.storage.sync.get('wclCacheTtlHours');
    const hours = parseFloat(wclCacheTtlHours);
    return (isNaN(hours) || hours <= 0) ? DEFAULT_TTL_MS : hours * 60 * 60 * 1000;
}

async function readCache(key) {
    const storageKey = CACHE_PREFIX + key;
    const result = await chrome.storage.local.get(storageKey);
    const entry = result[storageKey];
    if (!entry) return null;
    const ttl = await getCacheTtlMs();
    if (entry.cachedAt > Date.now() - ttl) return entry;
    return null;
}

async function writeCache(key, scores) {
    await chrome.storage.local.set({
        [CACHE_PREFIX + key]: { ...scores, cachedAt: Date.now() },
    });
}

// ─── Public API ────────────────────────────────────────────────────────────────
// getCharacterScore: never throws. Returns { best, median, notFound?, error?, rateLimitMs? }

async function getCharacterScore({ region, realm, name, role }) {
    const key = characterKey({ region, realm, name, role });

    const cached = await readCache(key);
    if (cached) return cached;

    if (inFlight.has(key)) return inFlight.get(key);

    const promise = (async () => {
        try {
            const metric = role === 'auto' ? 'auto' : roleToMetric(role);
            const scores = await queryCharacter({ name, serverSlug: realm, serverRegion: region, metric, role: role || 'dps' });
            await writeCache(key, scores);
            // An 'auto' lookup also answers the role-specific question, so write
            // it under the resolved role too — a later proactive pass that knows
            // the role from the page then hits the cache instead of the API.
            if (role === 'auto' && scores.role) {
                await writeCache(characterKey({ region, realm, name, role: scores.role }), scores);
            }
            return scores;
        } catch (err) {
            const message = err?.message || 'UNKNOWN_ERROR';
            const rateLimitMs   = message.startsWith('RATE_LIMITED:')     ? parseInt(message.split(':')[1]) * 1000 : undefined;
            const cloudflareMs  = message.startsWith('CLOUDFLARE_BLOCKED') ? (parseInt(message.split(':')[1]) * 1000 || CLOUDFLARE_COOLDOWN_MS) : undefined;
            return { best: null, median: null, error: message, rateLimitMs, cloudflareMs };
        } finally {
            inFlight.delete(key);
        }
    })();

    inFlight.set(key, promise);
    return promise;
}

async function testCredentials() {
    try {
        tokenCache = null;
        await chrome.storage.local.remove('wclToken');
        await getAccessToken();
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err?.message || 'UNKNOWN' };
    }
}

async function clearScoreCache() {
    const all = await chrome.storage.local.get(null);
    const toRemove = Object.keys(all).filter(k => k.startsWith(CACHE_PREFIX));
    if (toRemove.length) await chrome.storage.local.remove(toRemove);
}

async function hasCredentials() {
    return (await getCredentials()) !== null;
}

// Combined backoff status for the popup / options status bars.
// { state: 'ok' | 'rate-limited' | 'cloudflare', remainingMs }
async function getApiStatus() {
    const cf = await getCloudflareCooldown();
    if (cf > 0) return { state: 'cloudflare', remainingMs: cf };
    const rate = await getRateLimitCooldown();
    if (rate > 0) return { state: 'rate-limited', remainingMs: rate };
    return { state: 'ok', remainingMs: 0 };
}

// Called when the user has (re)loaded warcraftlogs.com in a real tab, which is
// what actually clears a Cloudflare challenge — drop the backoff so the next
// lookup tries again immediately instead of waiting out the cooldown.
async function clearCloudflareBackoff() {
    await clearCloudflareCooldown();
}

export {
    getCharacterScore,
    clearScoreCache,
    hasCredentials,
    testCredentials,
    storeSecret,
    getApiStatus,
    clearCloudflareBackoff,
};
