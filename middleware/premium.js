// middleware/premium.js
const pool = require('../config/db');

// Checks the CURRENT database state, not a claim baked into the JWT at login
// time. is_premium/subscription_expires_at can change (expire, get revoked)
// during the lifetime of an access token, so a stale token claim would let an
// expired subscription keep reaching a premium-only feature until the token
// itself expires. Must run after authenticateUser (needs req.user.user_id).
const requirePremium = async (req, res, next) => {
    if (!req.user || !req.user.user_id) {
        return res.status(401).json({ error: 'Access denied. No authenticated user.' });
    }

    try {
        const result = await pool.query(
            'SELECT is_premium, subscription_expires_at FROM users WHERE user_id = $1',
            [req.user.user_id]
        );

        if (result.rowCount === 0) {
            return res.status(401).json({ error: 'User not found.' });
        }

        const { is_premium, subscription_expires_at } = result.rows[0];
        const expired = subscription_expires_at && new Date(subscription_expires_at) < new Date();

        if (!is_premium || expired) {
            return res.status(403).json({
                error: 'This feature requires an active SoundScout Premium subscription.',
                code: 'PREMIUM_REQUIRED',
            });
        }

        next();
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server error checking premium status.' });
    }
};

module.exports = { requirePremium };
