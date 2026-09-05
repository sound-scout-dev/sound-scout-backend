// middleware/dbContext.js
const pool = require('../config/db');

// The RLS policies in migrations/001_row_level_security.sql key off the Postgres
// session variable app.current_user_id. A pool connection is reused across many
// different users' requests, so that variable can only safely be set for the
// lifetime of a single transaction on a dedicated client -- hence checking one out
// per request rather than using pool.query directly.
//
// Must run after authenticateUser (needs req.user.user_id). Route handlers use
// req.db.query(...) in place of pool.query(...) for any table covered by RLS;
// anything already inside req.db's transaction shares the same session context.
async function withUserContext(req, res, next) {
    if (!req.user || !req.user.user_id) {
        return res.status(401).json({ error: 'Access denied. No authenticated user for database context.' });
    }

    const client = await pool.connect();
    let settled = false;

    const settle = async (commit) => {
        if (settled) return;
        settled = true;
        try {
            await client.query(commit ? 'COMMIT' : 'ROLLBACK');
        } catch (err) {
            console.error('withUserContext: failed to finalize transaction:', err.message);
        } finally {
            client.release();
        }
    };

    try {
        await client.query('BEGIN');
        // is_local = true (3rd arg) scopes this to the current transaction only,
        // equivalent to SET LOCAL -- it never leaks into whatever request the pool
        // hands this physical connection to next.
        await client.query("SELECT set_config('app.current_user_id', $1, true)", [String(req.user.user_id)]);
    } catch (err) {
        await settle(false);
        console.error('withUserContext: failed to establish DB context:', err.message);
        return res.status(500).json({ error: 'Server error establishing database context.' });
    }

    req.db = client;

    // Route handlers call res.status(...).json(...) themselves rather than calling
    // next() with a result, so 'finish'/'close' are where we learn the outcome.
    // Anything short of a 4xx/5xx commits; an error status rolls back whatever
    // partial writes happened before it was set.
    res.on('finish', () => settle(res.statusCode < 400));
    res.on('close', () => settle(false));

    next();
}

module.exports = { withUserContext };
