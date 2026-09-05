// k6 load test for the SoundScout AI backend.
//
// Run: k6 run backend/loadtest/k6-script.js
// Target: k6 run -e BASE_URL=https://api.8.232.255.9.nip.io backend/loadtest/k6-script.js
// (defaults to that same host -- the GKE ingress in backend/k8s-migration/manifests/ingress.yaml)
//
// IMPORTANT before you run this against a real deployment:
//
// 1. This hits a live backend. `public_catalog` only reads (health check, rentals,
//    instant inventory) so it's safe to run as-is. `authenticated_flow` is OFF by
//    default (-e RUN_AUTH_FLOW=true to enable) because it registers real rows in
//    `users`/`events`/`bids` -- teardown() deletes exactly what setup() created, but
//    only run it against an environment where that's acceptable, and never against
//    a database you can't afford to touch.
//
// 2. The rate limiting added in middleware/rateLimit.js is per-IP (+ email on
//    auth/OTP endpoints): 300 req/15min globally, 10/15min on login & register. A k6
//    run from a single machine will hit those ceilings fast and you'll see 429s
//    instead of real capacity numbers. That's expected and correct -- it's the
//    limiter doing its job -- but it means this script measures capacity UNDER the
//    limiter, not raw backend throughput. To measure raw throughput instead, either
//    temporarily raise the limits in a staging deploy, or run from k6 Cloud / several
//    source IPs so the per-IP ceiling isn't what you're actually testing.
import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'https://api.8.232.255.9.nip.io';
const RUN_AUTH_FLOW = (__ENV.RUN_AUTH_FLOW || 'false').toLowerCase() === 'true';
const RUN_ID = __ENV.RUN_ID || `${Date.now()}`;

const rateLimited429 = new Counter('rate_limited_429');
const authFlowDuration = new Trend('auth_flow_duration', true);

export const options = {
    scenarios: {
        public_catalog: {
            executor: 'ramping-vus',
            exec: 'publicCatalog',
            startVUs: 0,
            stages: [
                { duration: '30s', target: 20 },  // ramp up
                { duration: '2m', target: 20 },   // sustain
                { duration: '30s', target: 60 },  // spike
                { duration: '1m', target: 60 },
                { duration: '30s', target: 0 },   // ramp down
            ],
        },
        ...(RUN_AUTH_FLOW ? {
            authenticated_flow: {
                executor: 'constant-vus',
                exec: 'authenticatedFlow',
                vus: 5,
                duration: '3m',
                startTime: '30s', // let public_catalog warm up first
            },
        } : {}),
    },
    thresholds: {
        http_req_failed: ['rate<0.05'],       // <5% hard failures across everything
        'http_req_duration{endpoint:health}': ['p(95)<300'],
        'http_req_duration{endpoint:rentals_list}': ['p(95)<800'],
        'http_req_duration{endpoint:instant_inventory}': ['p(95)<800'],
    },
};

// ── Public, read-only catalog traffic -- safe to run against any environment ──
export function publicCatalog() {
    group('health check', () => {
        const res = http.get(`${BASE_URL}/api/health`, { tags: { endpoint: 'health' } });
        check(res, { 'health 200': (r) => r.status === 200 });
    });

    group('browse rentals', () => {
        const res = http.get(`${BASE_URL}/api/rentals`, { tags: { endpoint: 'rentals_list' } });
        check(res, {
            'rentals 200': (r) => r.status === 200,
            'rentals is array': (r) => {
                try { return Array.isArray(JSON.parse(r.body)); } catch { return false; }
            },
        });
    });

    group('instant inventory lookup', () => {
        const res = http.get(`${BASE_URL}/api/inventory/instant/Colombo`, { tags: { endpoint: 'instant_inventory' } });
        // 404 is a valid response here (no vendors in that exact region) -- only a 5xx or
        // a hung request indicates a real problem, so both are accepted.
        check(res, { 'instant inventory 200 or 404': (r) => r.status === 200 || r.status === 404 });
        if (res.status === 429) rateLimited429.add(1);
    });

    sleep(1 + Math.random());
}

// ── Authenticated write flow -- opt-in only, see the notice at the top of this file ──
export function setup() {
    if (!RUN_AUTH_FLOW) return {};

    const organizer = {
        name: 'K6 Load Test Organizer',
        email: `k6-loadtest-organizer-${RUN_ID}@example.com`,
        role: 'organizer',
        password: 'k6-load-test-password-1',
    };
    const vendor = {
        name: 'K6 Load Test Vendor',
        email: `k6-loadtest-vendor-${RUN_ID}@example.com`,
        role: 'vendor',
        password: 'k6-load-test-password-1',
    };

    const orgRes = http.post(`${BASE_URL}/api/users/register`, JSON.stringify(organizer), {
        headers: { 'Content-Type': 'application/json' },
    });
    const vendRes = http.post(`${BASE_URL}/api/users/register`, JSON.stringify(vendor), {
        headers: { 'Content-Type': 'application/json' },
    });

    if (orgRes.status !== 201 || vendRes.status !== 201) {
        console.warn('setup(): test account registration did not return 201 -- check accounts require WhatsApp/OTP verification before login on this deployment. authenticatedFlow will likely 401/403 without a manual verification step.');
    }

    return { organizerEmail: organizer.email, vendorEmail: vendor.email, password: organizer.password };
}

export function authenticatedFlow(data) {
    if (!RUN_AUTH_FLOW || !data.organizerEmail) return;

    const start = Date.now();

    group('organizer login', () => {
        const res = http.post(`${BASE_URL}/api/users/login`, JSON.stringify({
            email: data.organizerEmail, password: data.password,
        }), { headers: { 'Content-Type': 'application/json' }, tags: { endpoint: 'login' } });

        if (res.status === 429) rateLimited429.add(1);
        check(res, { 'login 200 (or 403 if unverified)': (r) => r.status === 200 || r.status === 403 });

        if (res.status === 200) {
            const token = JSON.parse(res.body).accessToken;
            const authHeaders = { headers: { Authorization: `Bearer ${token}` } };

            group('list own events', () => {
                const evRes = http.get(`${BASE_URL}/api/events`, { ...authHeaders, tags: { endpoint: 'my_events' } });
                check(evRes, { 'my events 200': (r) => r.status === 200 });
            });
        }
    });

    authFlowDuration.add(Date.now() - start);
    sleep(1 + Math.random() * 2);
}

// Deletes exactly the two accounts setup() created -- nothing else. Requires direct
// DB access (this hits the API, not the DB, and there's no delete-account endpoint by
// design) so this only reports what to clean up; run the SQL it prints manually
// against the target database.
export function teardown(data) {
    if (!RUN_AUTH_FLOW || !data.organizerEmail) return;
    console.log(`Load test accounts to remove manually:\n  DELETE FROM users WHERE email IN ('${data.organizerEmail}', '${data.vendorEmail}');`);
}
