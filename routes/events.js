// routes/events.js
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticateUser, requireRole } = require('../middleware/auth');

function extractDistrictFromLocation(location) {
    if (!location) return 'Colombo';
    const locLower = location.toLowerCase();
    if (locLower.includes('moratuwa') || locLower.includes('nugegoda') || locLower.includes('maharagama') || locLower.includes('dehiwala') || locLower.includes('mount lavinia') || locLower.includes('colombo') || locLower.includes('kotte') || locLower.includes('homagama') || locLower.includes('battaramulla') || locLower.includes('malabe')) {
        return 'Colombo';
    }
    if (locLower.includes('gampaha') || locLower.includes('negombo') || locLower.includes('kelaniya') || locLower.includes('wattala') || locLower.includes('kadawatha') || locLower.includes('ja-ela')) {
        return 'Gampaha';
    }
    if (locLower.includes('kalutara') || locLower.includes('panadura') || locLower.includes('horana') || locLower.includes('beruwala')) {
        return 'Kalutara';
    }
    if (locLower.includes('kandy') || locLower.includes('peradeniya') || locLower.includes('katugastota') || locLower.includes('gampola')) {
        return 'Kandy';
    }
    if (locLower.includes('galle') || locLower.includes('hikkaduwa')) {
        return 'Galle';
    }
    if (locLower.includes('matara') || locLower.includes('weligama')) {
        return 'Matara';
    }
    if (locLower.includes('jaffna')) {
        return 'Jaffna';
    }
    if (locLower.includes('kurunegala')) {
        return 'Kurunegala';
    }
    return 'Colombo';
}

// POST /api/events - Organizer submits a new event
router.post('/', authenticateUser, requireRole('organizer'), async (req, res) => {
    const { name, event_type, crowd_count, venue_size_sqm, budget_range, environment, requirements, description, location, event_date } = req.body;
    const organizer_id = req.user.user_id; // Securely derive from token, preventing spoofing

    if (!event_type || !crowd_count) {
        return res.status(400).json({ error: 'event_type and crowd_count are required.' });
    }

    try {
        // Safe integer conversion to prevent database exceptions on floats
        const crowd = Math.round(Number(crowd_count)) || 0;
        const venue_size = venue_size_sqm ? Math.round(Number(venue_size_sqm)) : null;

        const req_json = requirements ? JSON.stringify(requirements) : JSON.stringify(["Audio", "Lighting", "Staging"]);
        const env = environment || 'Indoor';

        // District is initially null; Python AI service will resolve it via LLM location analysis during plan generation
        const result = await pool.query(
            `INSERT INTO events (organizer_id, name, event_type, crowd_count, venue_size_sqm, budget_range, environment, requirements, description, location, district, event_date)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
            [organizer_id, name || null, event_type, crowd, venue_size, budget_range, env, req_json, description || '', location || '', null, event_date || null]
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
        // Retrieve the vendor's working region/district
        const vendorRes = await pool.query(
            "SELECT region FROM users WHERE user_id = $1",
            [req.user.user_id]
        );
        const region = vendorRes.rows[0]?.region ? vendorRes.rows[0].region.trim() : '';

        let queryStr = "SELECT * FROM events WHERE status = 'bidding_open'";
        let queryParams = [];

        if (region && region.toLowerCase() !== 'all') {
            const districts = region.split(',').map(d => d.trim()).filter(Boolean);
            if (districts.length > 0) {
                const placeholders = districts.map((_, i) => `$${i + 1}`).join(', ');
                const ilikeConditions = districts.map((_, i) => `location ILIKE $${districts.length + i + 1}`).join(' OR ');

                // Rule: Event is visible if:
                // 1. District is NULL / empty / 'Unknown' (unidentified location -> open to ALL vendors)
                // 2. District matches vendor's registered district
                // 3. Location string matches vendor's district
                queryStr += ` AND (
                    district IS NULL OR 
                    district = '' OR 
                    LOWER(district) = 'unknown' OR 
                    LOWER(district) = 'all' OR 
                    district IN (${placeholders}) OR 
                    (${ilikeConditions})
                )`;
                queryParams = [...districts, ...districts.map(d => `%${d}%`)];
            }
        }

        queryStr += " ORDER BY created_at DESC";

        const result = await pool.query(queryStr, queryParams);
        const events = result.rows;

        // Fetch existing bids for these events
        const eventIds = events.map(e => e.event_id);
        let bidsMap = {};
        if (eventIds.length > 0) {
            const bidsRes = await pool.query(
                `SELECT b.event_id, b.bid_id, b.proposed_price, b.notes, b.bid_categories, u.name AS vendor_name
                 FROM bids b
                 JOIN users u ON b.vendor_id = u.user_id
                 WHERE b.event_id = ANY($1)`,
                [eventIds]
            );
            bidsRes.rows.forEach(bid => {
                if (!bidsMap[bid.event_id]) {
                    bidsMap[bid.event_id] = [];
                }
                bidsMap[bid.event_id].push(bid);
            });
        }

        const enrichedEvents = events.map(e => ({
            ...e,
            existing_bids: bidsMap[e.event_id] || []
        }));

        res.status(200).json(enrichedEvents);
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
                budget_range: eventDetails.budget_range,
                environment: eventDetails.environment,
                requirements: eventDetails.requirements,
                description: eventDetails.description,
                location: eventDetails.location,
                venue_photo_analysis: req.body.venue_photo_analysis || null
            })
        });

        if (!aiResponse.ok) {
            throw new Error(`AI service responded with status: ${aiResponse.status}`);
        }

        const aiData = await aiResponse.json();
        let resolvedDistrict = aiData.resolved_district || null;
        if (resolvedDistrict && (resolvedDistrict.toLowerCase() === 'unknown' || resolvedDistrict.toLowerCase() === 'none')) {
            resolvedDistrict = null; // Unidentified location -> Visible to all vendors!
        }

        // 4. Update the database with the generated dual-plan options, keep status as draft, and save AI resolved district
        const updateResult = await pool.query(
            `UPDATE events 
             SET ai_infrastructure_plan = $1, district = $2, status = 'draft' 
             WHERE event_id = $3 RETURNING *`,
            [JSON.stringify(aiData), resolvedDistrict, eventId]
        );

        res.status(200).json({
            message: 'AI Plan generated successfully. Awaiting option selection.',
            event: updateResult.rows[0],
            options: aiData
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
        const result = await pool.query(
            `SELECT e.*, u.name AS organizer_name, u.phone AS organizer_phone 
             FROM events e 
             JOIN users u ON e.organizer_id = u.user_id 
             WHERE e.event_id = $1`, 
            [eventId]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Event not found.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server error fetching event details.' });
    }
});

// GET /api/events - Retrieve all events owned by the logged-in organizer
router.get('/', authenticateUser, requireRole('organizer'), async (req, res) => {
    const organizer_id = req.user.user_id;
    try {
        const result = await pool.query(
            "SELECT * FROM events WHERE organizer_id = $1 ORDER BY created_at DESC",
            [organizer_id]
        );
        res.status(200).json(result.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server error fetching organizer events.' });
    }
});

// PUT /api/events/:eventId/finalize-plan - Finalize the selected AI plan
router.put('/:eventId/finalize-plan', authenticateUser, requireRole('organizer'), async (req, res) => {
    const { eventId } = req.params;
    const { selected_plan } = req.body;
    const organizer_id = req.user.user_id;

    if (!selected_plan) {
        return res.status(400).json({ error: 'selected_plan is required.' });
    }

    try {
        // Update the event's ai_infrastructure_plan with the finalized version and set to open
        const result = await pool.query(
            `UPDATE events SET ai_infrastructure_plan = $1, status = 'bidding_open' 
             WHERE event_id = $2 AND organizer_id = $3 RETURNING *`,
            [JSON.stringify(selected_plan), eventId, organizer_id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Event not found or unauthorized.' });
        }

        res.status(200).json({ message: 'Plan finalized successfully.', event: result.rows[0] });
    } catch (err) {
        console.error('Finalize Plan Error:', err.message);
        res.status(500).json({ error: 'Server error while finalizing plan.' });
    }
});

module.exports = router;
