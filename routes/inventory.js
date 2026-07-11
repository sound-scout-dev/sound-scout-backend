const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// GET /api/inventory/instant/:region - Fetch nearest vendors for Track 2 emergency rentals
router.get('/instant/:region', async (req, res) => {
    const { region } = req.params;

    try {
        // For the hackathon, we match vendors by the exact region string (e.g., 'Colombo 03')
        // We limit it to 5 to match your pitch deck criteria
        const result = await pool.query(
            `SELECT user_id AS vendor_id, name AS shop_name, region 
       FROM users 
       WHERE role = 'vendor' AND region = $1 
       LIMIT 5`,
            [region]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'No available shops found in your region.' });
        }

        res.status(200).json(result.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server error fetching instant inventory.' });
    }
});

module.exports = router;