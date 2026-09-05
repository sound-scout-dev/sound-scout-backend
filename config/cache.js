// config/cache.js
// Upstash Redis (HTTP-based, no cluster to run -- fits a GKE deployment without an
// extra stateful pod). Needs UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN,
// which you get from creating a database at https://console.upstash.com. Without
// them, every helper below is a safe no-op: reads always miss (falling through to
// Postgres) and writes/invalidations do nothing -- local dev and any environment
// that hasn't provisioned Redis yet keep working unchanged.
const { Redis } = require('@upstash/redis');

let client = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    client = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
} else {
    console.warn('⚠️  UPSTASH_REDIS_REST_URL/TOKEN not set — response caching is disabled (reads go straight to Postgres).');
}

async function cacheGet(key) {
    if (!client) return null;
    try {
        return await client.get(key);
    } catch (err) {
        console.warn(`cache: GET ${key} failed:`, err.message);
        return null;
    }
}

async function cacheSet(key, value, ttlSeconds) {
    if (!client) return;
    try {
        await client.set(key, value, { ex: ttlSeconds });
    } catch (err) {
        console.warn(`cache: SET ${key} failed:`, err.message);
    }
}

async function cacheDel(keyOrKeys) {
    if (!client) return;
    const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
    if (keys.length === 0) return;
    try {
        await client.del(...keys);
    } catch (err) {
        console.warn(`cache: DEL ${keys.join(',')} failed:`, err.message);
    }
}

module.exports = { cacheGet, cacheSet, cacheDel, isCacheEnabled: () => !!client };
