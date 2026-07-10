const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// POST /api/events - Organizer submits a new event
router.post('/', async (req, res) => {
    const { organizer_id, event_type, crowd_count, venue_size_sqm, budget_range } = req.body;

    try {
        // Note: The ai_infrastructure_plan is left null here. 
        // We will update it later when the Python microservice returns the AI data.
        const result = await pool.query(
            `INSERT INTO events (organizer_id, event_type, crowd_count, venue_size_sqm, budget_range) 
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [organizer_id, event_type, crowd_count, venue_size_sqm, budget_range]
        );
        res.status(201).json({
            message: 'Event created, awaiting AI plan',
            event: result.rows[0]
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server error while creating event.' });
    }
});

// GET /api/events/open - Vendor dashboard fetches available jobs
router.get('/open', async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT * FROM events WHERE status = 'bidding_open' ORDER BY created_at DESC"
        );
        res.status(200).json(result.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server error fetching open events.' });
    }
});

module.exports = router;