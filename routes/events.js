// routes/events.js
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticateUser, requireRole } = require('../middleware/auth');

// POST /api/events - Organizer submits a new event
router.post('/', authenticateUser, requireRole('organizer'), async (req, res) => {
    const { event_type, crowd_count, venue_size_sqm, budget_range } = req.body;
    const organizer_id = req.user.user_id; // Securely derive from token, preventing spoofing

    if (!event_type || !crowd_count) {
        return res.status(400).json({ error: 'event_type and crowd_count are required.' });
    }

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
router.get('/open', authenticateUser, requireRole('vendor'), async (req, res) => {
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

// POST /api/events/:eventId/generate-plan - Bridge to AI Microservice
router.post('/:eventId/generate-plan', authenticateUser, requireRole('organizer'), async (req, res) => {
    const { eventId } = req.params;
    const organizer_id = req.user.user_id;

    try {
        // 1. Fetch the event details to send context to the AI service
        const eventResult = await pool.query(
            'SELECT * FROM events WHERE event_id = $1',
            [eventId]
        );

        if (eventResult.rowCount === 0) {
            return res.status(404).json({ error: 'Event not found.' });
        }

        const eventDetails = eventResult.rows[0];

        // 2. Authorization check: Verify the organizer owns this event
        if (eventDetails.organizer_id !== organizer_id) {
            return res.status(403).json({ error: 'Access forbidden. You do not own this event.' });
        }

        // 3. Call the AI microservice via native fetch
        const aiServiceUrl = process.env.AI_SERVICE_URL || 'http://localhost:8000/api/generate';

        const aiResponse = await fetch(aiServiceUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                event_type: eventDetails.event_type,
                crowd_count: eventDetails.crowd_count,
                venue_size_sqm: eventDetails.venue_size_sqm,
                budget_range: eventDetails.budget_range
            })
        });

        if (!aiResponse.ok) {
            throw new Error(`AI service responded with status: ${aiResponse.status}`);
        }

        const aiData = await aiResponse.json();

        // Ensure we're pulling the plan correctly depending on your Flask app's response structure
        const equipmentPlan = aiData.equipment_plan || aiData;

        // 4. Update the database with the generated plan
        const updateResult = await pool.query(
            `UPDATE events 
             SET ai_infrastructure_plan = $1, status = 'bidding_open' 
             WHERE event_id = $2 RETURNING *`,
            [JSON.stringify(equipmentPlan), eventId]
        );

        res.status(200).json({
            message: 'AI Plan generated successfully. Event is now open for bidding!',
            event: updateResult.rows[0]
        });

    } catch (err) {
        console.error('AI Bridge Error:', err.message);
        res.status(500).json({ error: 'Server error while generating AI plan.' });
    }
});

// GET /api/events/:eventId - Fetch details of a specific event
router.get('/:eventId', authenticateUser, async (req, res) => {
    const { eventId } = req.params;
    try {
        const result = await pool.query('SELECT * FROM events WHERE event_id = $1', [eventId]);
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Event not found.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server error fetching event details.' });
    }
});

module.exports = router;
