// config/secrets.js
// Centralizes every secret the backend signs/verifies data with. Previously each
// file read `process.env.X || '<hardcoded literal>'` independently, so a missing
// env var in production silently fell back to a secret checked into source control
// instead of failing loudly.
require('dotenv').config();

const IS_PROD = process.env.NODE_ENV === 'production';

// Only used outside production so local dev/test still works with a bare `npm run dev`
// and no .env file. These must never be reachable when IS_PROD is true.
const INSECURE_DEV_DEFAULTS = {
    ACCESS_TOKEN_SECRET: 'dev_only_access_secret_do_not_use_in_prod',
    REFRESH_TOKEN_SECRET: 'dev_only_refresh_secret_do_not_use_in_prod',
    WORKER_SECRET: 'dev_only_worker_secret_do_not_use_in_prod',
};

function requireSecret(name) {
    const value = process.env[name];
    if (value) return value;

    if (IS_PROD) {
        throw new Error(`Missing required environment variable ${name} in production. Refusing to start with an insecure default.`);
    }

    console.warn(`⚠️  ${name} is not set — using an insecure development-only default. Set it in .env before deploying.`);
    return INSECURE_DEV_DEFAULTS[name];
}

module.exports = {
    ACCESS_TOKEN_SECRET: requireSecret('ACCESS_TOKEN_SECRET'),
    REFRESH_TOKEN_SECRET: requireSecret('REFRESH_TOKEN_SECRET'),
    WORKER_SECRET: requireSecret('WORKER_SECRET'),
};
