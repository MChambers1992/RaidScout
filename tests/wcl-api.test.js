// tests/wcl-api.test.js
// The WarcraftLogs API client, exercised through its public surface.
//
// This is the module with the most behaviour and the least visibility: it holds
// the OAuth token, the score cache, and both backoff states, and every one of
// its failure modes is meant to be swallowed into a return value rather than
// thrown (getCharacterScore is documented as never throwing, because a content
// script that throws mid-pass leaves a page half-filtered).
//
// It keeps module-level state (tokenCache, the in-flight map), so every test
// re-imports it through vi.resetModules() rather than sharing one instance.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Mocks ─────────────────────────────────────────────────────────────────────

// A chrome.storage stand-in supporting the shapes wcl-api.js actually calls:
// get(string), get(null) for "everything", set(object), remove(string|string[]).
function storageArea(store) {
    return {
        get: async (keys) => {
            if (keys === null || keys === undefined) return { ...store };
            const list = Array.isArray(keys) ? keys : [keys];
            const out = {};
            for (const k of list) if (k in store) out[k] = store[k];
            return out;
        },
        set: async (obj) => { Object.assign(store, obj); },
        remove: async (keys) => {
            for (const k of (Array.isArray(keys) ? keys : [keys])) delete store[k];
        },
    };
}

function installChrome({ local = {}, sync = {} } = {}) {
    const localStore = { ...local };
    const syncStore  = { ...sync };
    globalThis.chrome = {
        storage: { local: storageArea(localStore), sync: storageArea(syncStore) },
    };
    return { localStore, syncStore };
}

// Credentials the client considers usable (both halves present).
const CREDS = { local: { wclClientSecret: 'secret' }, sync: { wclClientId: 'id' } };

function response({ status = 200, json = {}, text = '', headers = {} } = {}) {
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name) => lower[String(name).toLowerCase()] ?? null },
        json: async () => json,
        text: async () => text,
    };
}

const tokenResponse = () => response({ json: { access_token: 'tok', expires_in: 3600 } });

// Wraps a zoneRankings blob in the GraphQL envelope the client unwraps.
function charResponse({ dps = null, hps = null } = {}) {
    return response({ json: { data: { characterData: { character: { dps, hps } } } } });
}

const rankings = ({ best = null, median = null, spec = null } = {}) => ({
    bestPerformanceAverage: best,
    medianPerformanceAverage: median,
    ...(spec ? { allStars: [{ spec }] } : {}),
});

// Queues responses in order; every call past the end reuses the last one.
function mockFetch(...responses) {
    const fn = vi.fn(async () => responses[Math.min(fn.mock.calls.length - 1, responses.length - 1)]);
    globalThis.fetch = fn;
    return fn;
}

// The request body of the Nth fetch call, parsed.
const bodyOf = (fetchMock, n) => JSON.parse(fetchMock.mock.calls[n][1].body);

const CHAR = { region: 'eu', realm: 'tarren-mill', name: 'Someone' };

let api;
async function load(storage) {
    vi.resetModules();
    installChrome(storage);
    api = await import('../src/wcl-api.js');
    return api;
}

beforeEach(async () => {
    vi.restoreAllMocks();
    await load(CREDS);
});

// ─── Credentials ───────────────────────────────────────────────────────────────

describe('credentials', () => {
    it('needs both halves before it reports having them', async () => {
        await load({ local: {}, sync: {} });
        expect(await api.hasCredentials()).toBe(false);

        await load({ local: {}, sync: { wclClientId: 'id' } });
        expect(await api.hasCredentials()).toBe(false);

        await load({ local: { wclClientSecret: 's' }, sync: {} });
        expect(await api.hasCredentials()).toBe(false);

        await load(CREDS);
        expect(await api.hasCredentials()).toBe(true);
    });

    it('reports a missing key as an error rather than throwing', async () => {
        await load({ local: {}, sync: {} });
        const fetchMock = mockFetch(tokenResponse());

        // Quirk 8: a misconfigured install must fail open, which only works if
        // this resolves to an error value the filters can recognise.
        const score = await api.getCharacterScore({ ...CHAR, role: 'dps' });
        expect(score.error).toBe('NO_CREDENTIALS');
        expect(score.best).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('moves the secret to local storage and wipes it from sync', async () => {
        // The whole point of storeSecret: Chrome Sync must never carry it.
        const { localStore, syncStore } = installChrome({ sync: { wclClientSecret: 'leaked' } });
        vi.resetModules();
        api = await import('../src/wcl-api.js');

        await api.storeSecret('fresh');
        expect(localStore.wclClientSecret).toBe('fresh');
        expect('wclClientSecret' in syncStore).toBe(false);
    });
});

// ─── Token handling ────────────────────────────────────────────────────────────

describe('access token', () => {
    it('exchanges credentials for a token before the first query', async () => {
        const fetchMock = mockFetch(tokenResponse(), charResponse({ dps: rankings({ best: 80 }) }));
        await api.getCharacterScore({ ...CHAR, role: 'dps' });

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls[0][0]).toContain('/oauth/token');
        expect(fetchMock.mock.calls[1][0]).toContain('/api/v2/client');
        expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer tok');
    });

    it('reuses a persisted token instead of re-authenticating', async () => {
        await load({
            ...CREDS,
            local: { ...CREDS.local, wclToken: { accessToken: 'stored', expiresAt: Date.now() + 3_600_000 } },
        });
        const fetchMock = mockFetch(charResponse({ dps: rankings({ best: 70 }) }));

        await api.getCharacterScore({ ...CHAR, role: 'dps' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer stored');
    });

    it('treats a token inside its last minute as already expired', async () => {
        // The 60s margin exists so a token cannot expire mid-flight.
        await load({
            ...CREDS,
            local: { ...CREDS.local, wclToken: { accessToken: 'stale', expiresAt: Date.now() + 30_000 } },
        });
        const fetchMock = mockFetch(tokenResponse(), charResponse({ dps: rankings({ best: 60 }) }));

        await api.getCharacterScore({ ...CHAR, role: 'dps' });
        expect(fetchMock.mock.calls[0][0]).toContain('/oauth/token');
    });

    it('re-authenticates once on a 401 and does not loop', async () => {
        const fetchMock = mockFetch(
            tokenResponse(),
            response({ status: 401 }),          // query rejected
            tokenResponse(),                    // fresh token
            response({ status: 401 }),          // rejected again
        );

        const score = await api.getCharacterScore({ ...CHAR, role: 'dps' });
        // Token, query, token, query — then it gives up rather than retrying forever.
        expect(fetchMock).toHaveBeenCalledTimes(4);
        expect(score.error).toContain('401');
    });
});

// ─── Role-aware metric ─────────────────────────────────────────────────────────

describe('role to metric', () => {
    it('asks for hps for healers and dps for everyone else', async () => {
        for (const [role, metric] of [['healer', 'hps'], ['dps', 'dps'], ['tank', 'dps']]) {
            await load(CREDS);
            const fetchMock = mockFetch(tokenResponse(), charResponse({ dps: rankings({ best: 50 }) }));
            await api.getCharacterScore({ ...CHAR, role });
            expect(bodyOf(fetchMock, 1).query).toContain(`zoneRankings(metric: ${metric})`);
        }
    });

    it('fetches both metrics in one request for role auto', async () => {
        // The point of the aliased query: resolving a role costs one round trip.
        const fetchMock = mockFetch(tokenResponse(), charResponse({ dps: rankings({ best: 50 }) }));
        await api.getCharacterScore({ ...CHAR, role: 'auto' });

        const { query } = bodyOf(fetchMock, 1);
        expect(query).toContain('dps: zoneRankings(metric: dps)');
        expect(query).toContain('hps: zoneRankings(metric: hps)');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});

// ─── Role auto-resolution ──────────────────────────────────────────────────────

describe('role auto-resolution', () => {
    it('reads the healer block when the ranked spec is a healing spec', async () => {
        const fetchMock = mockFetch(tokenResponse(), charResponse({
            dps: rankings({ best: 5,  median: 4,  spec: 'Restoration' }),
            hps: rankings({ best: 91, median: 88 }),
        }));

        const score = await api.getCharacterScore({ ...CHAR, role: 'auto' });
        expect(score.role).toBe('healer');
        expect(score.spec).toBe('Restoration');
        // The HPS numbers, not the near-zero DPS ones they also rank for.
        expect(score.best).toBe(91);
        expect(score.median).toBe(88);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('falls back to the per-encounter spec when there are no all-stars', async () => {
        mockFetch(tokenResponse(), charResponse({
            dps: { bestPerformanceAverage: 77, medianPerformanceAverage: 70,
                   rankings: [{ bestSpec: 'Vengeance' }] },
        }));

        const score = await api.getCharacterScore({ ...CHAR, role: 'auto' });
        expect(score.role).toBe('tank');
        expect(score.best).toBe(77);
    });

    it('defaults to dps when no spec was ranked at all', async () => {
        mockFetch(tokenResponse(), charResponse({ dps: rankings({ best: 40 }) }));
        const score = await api.getCharacterScore({ ...CHAR, role: 'auto' });
        expect(score.role).toBe('dps');
        expect(score.spec).toBeNull();
    });

    it("keeps the caller's role when one was named", async () => {
        // Quirk: only 'auto' lets the spec pick the role. When the caller named
        // a role we returned that role's numbers, so relabelling them would
        // apply the wrong thresholds to the figures we just handed back.
        mockFetch(tokenResponse(), charResponse({ dps: rankings({ best: 60, spec: 'Restoration' }) }));
        const score = await api.getCharacterScore({ ...CHAR, role: 'tank' });
        expect(score.role).toBe('tank');
    });
});

// ─── Not found / malformed ─────────────────────────────────────────────────────

describe('missing and malformed answers', () => {
    it('reports an unknown character as notFound, not an error', async () => {
        mockFetch(tokenResponse(), response({ json: { data: { characterData: { character: null } } } }));
        const score = await api.getCharacterScore({ ...CHAR, role: 'dps' });
        expect(score.notFound).toBe(true);
        expect(score.error).toBeUndefined();
    });

    it('turns a GraphQL error into a returned error', async () => {
        mockFetch(tokenResponse(), response({ json: { errors: [{ message: 'bad query' }] } }));
        const score = await api.getCharacterScore({ ...CHAR, role: 'dps' });
        expect(score.error).toContain('bad query');
        expect(score.best).toBeNull();
    });

    it('treats an empty rankings blob as no scores rather than crashing', async () => {
        mockFetch(tokenResponse(), charResponse({ dps: null }));
        const score = await api.getCharacterScore({ ...CHAR, role: 'dps' });
        expect(score.best).toBeNull();
        expect(score.median).toBeNull();
        expect(score.error).toBeUndefined();
    });
});

// ─── Caching ───────────────────────────────────────────────────────────────────

describe('score cache', () => {
    it('serves a second lookup without touching the API', async () => {
        const fetchMock = mockFetch(tokenResponse(), charResponse({ dps: rankings({ best: 80, median: 75 }) }));

        await api.getCharacterScore({ ...CHAR, role: 'dps' });
        const second = await api.getCharacterScore({ ...CHAR, role: 'dps' });

        expect(fetchMock).toHaveBeenCalledTimes(2);   // no third call
        expect(second.best).toBe(80);
    });

    it('keys the cache by role so an alt does not collide with itself', async () => {
        const fetchMock = mockFetch(
            tokenResponse(),
            charResponse({ dps: rankings({ best: 80 }) }),
            charResponse({ dps: rankings({ best: 20 }), hps: rankings({ best: 20 }) }),
        );

        const asDps    = await api.getCharacterScore({ ...CHAR, role: 'dps' });
        const asHealer = await api.getCharacterScore({ ...CHAR, role: 'healer' });

        expect(asDps.best).toBe(80);
        expect(asHealer.best).toBe(20);
        expect(fetchMock).toHaveBeenCalledTimes(3);   // both roles really queried
    });

    it('writes an auto lookup under the resolved role as well', async () => {
        // Quirk 11: so a later role-specific pass hits the cache, not the API.
        const fetchMock = mockFetch(tokenResponse(), charResponse({
            dps: rankings({ best: 10, spec: 'Restoration' }),
            hps: rankings({ best: 95 }),
        }));

        await api.getCharacterScore({ ...CHAR, role: 'auto' });
        const asHealer = await api.getCharacterScore({ ...CHAR, role: 'healer' });

        expect(asHealer.best).toBe(95);
        expect(fetchMock).toHaveBeenCalledTimes(2);   // the healer lookup was free
    });

    it('caches a notFound but never caches an error', async () => {
        // notFound is information about the player; an error is information
        // about the request, and would poison the cache for the whole TTL.
        const fetchMock = mockFetch(
            tokenResponse(),
            response({ status: 500 }),
            charResponse({ dps: rankings({ best: 65 }) }),
        );

        const failed = await api.getCharacterScore({ ...CHAR, role: 'dps' });
        expect(failed.error).toBeTruthy();

        const retried = await api.getCharacterScore({ ...CHAR, role: 'dps' });
        expect(retried.best).toBe(65);                // re-queried, not served stale
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('re-queries once the entry is older than the configured TTL', async () => {
        const stale = {
            'wclScore:eu/tarren-mill/someone/dps': { best: 1, median: 1, cachedAt: Date.now() - 7 * 60 * 60 * 1000 },
        };
        await load({ local: { ...CREDS.local, ...stale }, sync: { ...CREDS.sync, wclCacheTtlHours: 6 } });
        mockFetch(tokenResponse(), charResponse({ dps: rankings({ best: 88 }) }));

        const score = await api.getCharacterScore({ ...CHAR, role: 'dps' });
        expect(score.best).toBe(88);
    });

    it('clearScoreCache removes score entries and leaves everything else', async () => {
        const { localStore } = installChrome({
            local: {
                'wclScore:eu/realm/a/dps': { best: 1 },
                'wclScore:eu/realm/b/hps': { best: 2 },
                wclClientSecret: 'keep me',
                wclToken: { accessToken: 'keep me too' },
            },
        });
        vi.resetModules();
        api = await import('../src/wcl-api.js');

        await api.clearScoreCache();
        expect(Object.keys(localStore).sort()).toEqual(['wclClientSecret', 'wclToken']);
    });
});

// ─── Rate limiting ─────────────────────────────────────────────────────────────

describe('rate limit backoff', () => {
    it('stores the Retry-After cooldown and reports it in ms', async () => {
        const { localStore } = installChrome(CREDS);
        vi.resetModules();
        api = await import('../src/wcl-api.js');
        mockFetch(tokenResponse(), response({ status: 429, headers: { 'Retry-After': '30' } }));

        const score = await api.getCharacterScore({ ...CHAR, role: 'dps' });
        expect(score.error).toBe('RATE_LIMITED:30');
        expect(score.rateLimitMs).toBe(30_000);
        expect(localStore.wclRateLimitUntil).toBeGreaterThan(Date.now());
    });

    it('refuses further lookups while the cooldown is live, without fetching', async () => {
        await load({
            local: { ...CREDS.local, wclRateLimitUntil: Date.now() + 45_000 },
            sync: CREDS.sync,
        });
        const fetchMock = mockFetch(tokenResponse());

        const score = await api.getCharacterScore({ ...CHAR, role: 'dps' });
        expect(score.error).toMatch(/^RATE_LIMITED:/);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('clears a stale cooldown after a call succeeds', async () => {
        const { localStore } = installChrome({
            local: { ...CREDS.local, wclRateLimitUntil: Date.now() - 1000 },  // already expired
            sync: CREDS.sync,
        });
        vi.resetModules();
        api = await import('../src/wcl-api.js');
        mockFetch(tokenResponse(), charResponse({ dps: rankings({ best: 55 }) }));

        await api.getCharacterScore({ ...CHAR, role: 'dps' });
        expect('wclRateLimitUntil' in localStore).toBe(false);
    });
});

// ─── Cloudflare ────────────────────────────────────────────────────────────────

describe('cloudflare challenge', () => {
    const CF_MS = 5 * 60 * 1000;

    it('recognises the cf-mitigated header', async () => {
        const { localStore } = installChrome(CREDS);
        vi.resetModules();
        api = await import('../src/wcl-api.js');
        mockFetch(tokenResponse(), response({ status: 403, headers: { 'cf-mitigated': 'challenge' } }));

        const score = await api.getCharacterScore({ ...CHAR, role: 'dps' });
        expect(score.error).toMatch(/^CLOUDFLARE_BLOCKED:/);
        expect(score.cloudflareMs).toBe(CF_MS);
        expect(localStore.wclCloudflareUntil).toBeGreaterThan(Date.now());
    });

    it('recognises an interstitial body', async () => {
        mockFetch(tokenResponse(), response({ status: 503, text: '<title>Just a moment...</title>' }));
        const score = await api.getCharacterScore({ ...CHAR, role: 'dps' });
        expect(score.error).toMatch(/^CLOUDFLARE_BLOCKED:/);
    });

    it('recognises an unmarked block page from cf-ray plus HTML', async () => {
        mockFetch(tokenResponse(), response({
            status: 403,
            headers: { 'cf-ray': '8a1b2c3d', 'content-type': 'text/html; charset=utf-8' },
        }));
        const score = await api.getCharacterScore({ ...CHAR, role: 'dps' });
        expect(score.error).toMatch(/^CLOUDFLARE_BLOCKED:/);
    });

    it('leaves an ordinary 403 as an ordinary error', async () => {
        // Backing off for five minutes on a plain auth failure would be wrong.
        const { localStore } = installChrome(CREDS);
        vi.resetModules();
        api = await import('../src/wcl-api.js');
        mockFetch(tokenResponse(), response({ status: 403, text: 'forbidden', headers: { 'content-type': 'application/json' } }));

        const score = await api.getCharacterScore({ ...CHAR, role: 'dps' });
        expect(score.error).not.toMatch(/CLOUDFLARE/);
        expect('wclCloudflareUntil' in localStore).toBe(false);
    });

    it('detects a challenge on the token request too', async () => {
        mockFetch(response({ status: 503, headers: { 'cf-mitigated': 'challenge' } }));
        const score = await api.getCharacterScore({ ...CHAR, role: 'dps' });
        expect(score.error).toMatch(/^CLOUDFLARE_BLOCKED:/);
    });

    it('short-circuits while the cooldown is live', async () => {
        await load({
            local: { ...CREDS.local, wclCloudflareUntil: Date.now() + 120_000 },
            sync: CREDS.sync,
        });
        const fetchMock = mockFetch(tokenResponse());

        const score = await api.getCharacterScore({ ...CHAR, role: 'dps' });
        expect(score.error).toMatch(/^CLOUDFLARE_BLOCKED:/);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('clearCloudflareBackoff drops the cooldown immediately', async () => {
        // Quirk 22: a real page load is what clears a challenge, not elapsed time.
        const { localStore } = installChrome({
            local: { ...CREDS.local, wclCloudflareUntil: Date.now() + 120_000 },
            sync: CREDS.sync,
        });
        vi.resetModules();
        api = await import('../src/wcl-api.js');

        await api.clearCloudflareBackoff();
        expect('wclCloudflareUntil' in localStore).toBe(false);
    });
});

// ─── Timeout ───────────────────────────────────────────────────────────────────

describe('fetch timeout', () => {
    it('reports an aborted request as FETCH_TIMEOUT', async () => {
        globalThis.fetch = vi.fn(async () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            throw err;
        });

        const score = await api.getCharacterScore({ ...CHAR, role: 'dps' });
        expect(score.error).toBe('FETCH_TIMEOUT');
        expect(score.best).toBeNull();
    });

    it('reports a network failure without throwing', async () => {
        globalThis.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
        const score = await api.getCharacterScore({ ...CHAR, role: 'dps' });
        expect(score.error).toContain('Failed to fetch');
    });
});

// ─── In-flight de-duplication ──────────────────────────────────────────────────

describe('in-flight de-duplication', () => {
    it('collapses concurrent lookups of the same character into one query', async () => {
        // Several rows on a page asking for the same alt must not each pay an
        // API call against the hourly budget.
        const fetchMock = mockFetch(tokenResponse(), charResponse({ dps: rankings({ best: 72 }) }));

        const [a, b, c] = await Promise.all([
            api.getCharacterScore({ ...CHAR, role: 'dps' }),
            api.getCharacterScore({ ...CHAR, role: 'dps' }),
            api.getCharacterScore({ ...CHAR, role: 'dps' }),
        ]);

        expect(fetchMock).toHaveBeenCalledTimes(2);   // token + one query
        expect([a.best, b.best, c.best]).toEqual([72, 72, 72]);
    });

    it('releases the key afterwards so a later lookup can run', async () => {
        const fetchMock = mockFetch(
            tokenResponse(),
            response({ status: 500 }),                              // not cached
            charResponse({ dps: rankings({ best: 64 }) }),
        );

        await api.getCharacterScore({ ...CHAR, role: 'dps' });
        const second = await api.getCharacterScore({ ...CHAR, role: 'dps' });
        expect(second.best).toBe(64);
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });
});

// ─── Status reporting ──────────────────────────────────────────────────────────

describe('getApiStatus', () => {
    it('reports ok when nothing is backed off', async () => {
        expect(await api.getApiStatus()).toEqual({ state: 'ok', remainingMs: 0 });
    });

    it('reports a live rate limit', async () => {
        await load({ local: { wclRateLimitUntil: Date.now() + 20_000 }, sync: {} });
        const status = await api.getApiStatus();
        expect(status.state).toBe('rate-limited');
        expect(status.remainingMs).toBeGreaterThan(0);
    });

    it('reports Cloudflare ahead of a rate limit when both are live', async () => {
        // Cloudflare is the one the user can act on, so it is the one to show.
        await load({
            local: { wclCloudflareUntil: Date.now() + 60_000, wclRateLimitUntil: Date.now() + 20_000 },
            sync: {},
        });
        expect((await api.getApiStatus()).state).toBe('cloudflare');
    });

    it('ignores a cooldown that has already elapsed', async () => {
        await load({ local: { wclRateLimitUntil: Date.now() - 1 }, sync: {} });
        expect((await api.getApiStatus()).state).toBe('ok');
    });
});

// ─── testCredentials ───────────────────────────────────────────────────────────

describe('testCredentials', () => {
    it('reports ok on a successful token exchange', async () => {
        mockFetch(tokenResponse());
        expect(await api.testCredentials()).toEqual({ ok: true });
    });

    it('reports the reason on failure instead of throwing', async () => {
        mockFetch(response({ status: 401, text: 'invalid_client' }));
        const result = await api.testCredentials();
        expect(result.ok).toBe(false);
        expect(result.error).toContain('401');
    });

    it('ignores a cached token so it really tests what the user just typed', async () => {
        await load({
            ...CREDS,
            local: { ...CREDS.local, wclToken: { accessToken: 'old', expiresAt: Date.now() + 3_600_000 } },
        });
        const fetchMock = mockFetch(tokenResponse());

        await api.testCredentials();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toContain('/oauth/token');
    });
});
