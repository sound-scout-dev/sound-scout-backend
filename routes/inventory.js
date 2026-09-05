const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { cacheGet, cacheSet } = require('../config/cache');

// GET /api/inventory/instant/:region - Fetch up to 5 vendor shops matching an exact region (hackathon MVP)
//
// Cached (unlike GET /api/rentals or GET /api/events/open, which deliberately opt out
// of caching -- those two are kept fresh via SSE/socket.io broadcasts, and a TTL cache
// in front of them would fight that real-time design). Which vendors are registered
// in a region changes rarely, there's no live-update mechanism for it at all today,
// and it's looked up on every "instant rental" page load -- a good, low-risk fit for
// a short TTL cache.
router.get('/instant/:region', async (req, res) => {
    const { region } = req.params;
    const cacheKey = `inventory:instant:${region}`;

    try {
        const cached = await cacheGet(cacheKey);
        if (cached) {
            return res.status(200).json(cached);
        }

        // For the hackathon, we match vendors by the exact region string (e.g., 'Colombo 03')
        // We limit it to 5 to match your pitch deck criteria
        const result = await pool.query(
            `SELECT user_id AS vendor_id, name AS shop_name, region
       FROM users
       WHERE role = 'vendor' AND region = $1
       ORDER BY name ASC
       LIMIT 5`,
            [region]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'No available shops found in your region.' });
        }

        await cacheSet(cacheKey, result.rows, 60);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server error fetching instant inventory.' });
    }
});

module.exports = router;