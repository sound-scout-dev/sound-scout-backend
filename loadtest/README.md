# Load testing

Requires [k6](https://k6.io/docs/get-started/installation/) (not an npm package — a standalone binary).

## Run

```bash
# Public, read-only catalog traffic only (safe default)
k6 run -e BASE_URL=https://api.8.232.255.9.nip.io backend/loadtest/k6-script.js

# Include the authenticated write flow (creates + deletes its own test accounts —
# read the notice at the top of k6-script.js before enabling this against a real deploy)
k6 run -e BASE_URL=https://api.8.232.255.9.nip.io -e RUN_AUTH_FLOW=true backend/loadtest/k6-script.js
```

Verified locally with a shortened run against `localhost:5000` — 100% checks passed, p95 ~4.5ms with a handful of VUs (see session notes). Numbers against the real deployment will differ; that's the point of running it there.

## Before running against the real deployment

The rate limiting in `middleware/rateLimit.js` (300 req/15min per IP globally, 10/15min per IP+email on login/register) will cap what a single-source k6 run can measure on those endpoints — you'll see 429s well before you find the backend's actual ceiling. That's the limiter working as intended, not a bug in the test. To measure raw backend capacity instead of the limiter's ceiling, either raise the limits temporarily in a staging deploy, or distribute the load across IPs (k6 Cloud).
