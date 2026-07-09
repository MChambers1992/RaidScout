// wcl-api.js
// WarcraftLogs API v2 client for the background service worker.
//
// Changes from v1:
//  - Role-aware metric: passes character role so healers get hps, tanks get dps
//  - AbortController timeout (10 s) on every fetch to prevent hung requests
//  - Rate-limit backoff: reads Retry-After header, stores cooldown in storage.local
//  - Credential secret moved to storage.local (not synced across devices)
//  - Debug logging toggle via wclDebug storage key
//  - configurable cache TTL via wclCacheTtlHours storage key (default 6)

const WCL_TOKEN_URL  = 'https://www.warcraftlogs.com/oauth/token';
const WCL_CLIENT_API = 'https://www.warcraftlogs.com/api/v2/client';
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_PREFIX   = 'wclScore:';
const FETCH_TIMEOUT_MS = 10_000;

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

function roleToMetric(role) {
    if (role === 'healer') return 'hps';
    return 'dps'; // dps and tank both use DPS metric
}

// ─── GraphQL query ─────────────────────────────────────────────────────────────

function buildQuery(metric) {
    return `
query ($name: String!, $serverSlug: String!, $serverRegion: String!) {
  characterData {
    character(name: $name, serverSlug: $serverSlug, serverRegion: $serverRegion) {
      zoneRankings(metric: ${metric})
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

async function queryCharacter({ name, serverSlug, serverRegion, metric = 'dps' }, retryOnAuth = true) {
    const cooldown = await getRateLimitCooldown();
    if (cooldown > 0) throw new Error(`RATE_LIMITED:${cooldown}`);

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
        return queryCharacter({ name, serverSlug, serverRegion, metric }, false);
    }

    if (res.status === 429) {
        const retryAfter = res.headers.get('Retry-After');
        await setRateLimitCooldown(retryAfter);
        throw new Error(`RATE_LIMITED:${retryAfter || '60'}`);
    }

    if (!res.ok) throw new Error(`WCL query failed (${res.status})`);

    // Successful response clears any stale rate-limit flag
    await clearRateLimitCooldown();

    const json = await res.json();
    if (json.errors?.length) throw new Error(`WCL GraphQL error: ${json.errors[0].message}`);

    const character = json?.data?.characterData?.character;
    if (!character) return { best: null, median: null, notFound: true };

    const scores = extractScores(character.zoneRankings);
    if (debug) dbg('scores', scores);
    return { ...scores, notFound: false };
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
            const metric = roleToMetric(role);
            const scores = await queryCharacter({ name, serverSlug: realm, serverRegion: region, metric });
            await writeCache(key, scores);
            return scores;
        } catch (err) {
            const message = err?.message || 'UNKNOWN_ERROR';
            const rateLimited = message.startsWith('RATE_LIMITED:');
            const rateLimitMs = rateLimited ? parseInt(message.split(':')[1]) * 1000 : undefined;
            return { best: null, median: null, error: message, rateLimitMs };
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

async function getRateLimitStatus() {
    const { wclRateLimitUntil } = await chrome.storage.local.get('wclRateLimitUntil');
    if (!wclRateLimitUntil || wclRateLimitUntil < Date.now()) return { limited: false };
    return { limited: true, remainingMs: wclRateLimitUntil - Date.now() };
}

export {
    getCharacterScore,
    clearScoreCache,
    hasCredentials,
    testCredentials,
    storeSecret,
    getRateLimitStatus,
};
