// routes/bids.js
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticateUser, requireRole } = require('../middleware/auth');

// POST /api/bids - Vendor submits a bid for an event
router.post('/', authenticateUser, requireRole('vendor'), async (req, res) => {
    const { event_id, proposed_price, notes, bid_categories } = req.body;
    const vendor_id = req.user.user_id; // Securely derive vendor identity

    if (!event_id || proposed_price === undefined) {
        return res.status(400).json({ error: 'event_id and proposed_price are required.' });
    }

    const price = Number(proposed_price);
    if (!Number.isFinite(price) || price <= 0) {
        return res.status(400).json({ error: 'proposed_price must be a positive number.' });
    }

    try {
        // A vendor may only place one bid per event — they choose which
        // categories that single bid covers, leaving the rest open for other
        // vendors to bid on.
        const existingBid = await pool.query(
            'SELECT bid_id FROM bids WHERE event_id = $1 AND vendor_id = $2',
            [event_id, vendor_id]
        );
        if (existingBid.rowCount > 0) {
            return res.status(409).json({ error: 'You have already placed a bid on this event.' });
        }

        const categoriesJson = bid_categories ? JSON.stringify(bid_categories) : null;
        const result = await pool.query(
            `INSERT INTO bids (event_id, vendor_id, proposed_price, notes, bid_categories)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [event_id, vendor_id, price, notes, categoriesJson]
        );

        const newBid = result.rows[0];

        // --- WEB SOCKET EMIT ---
        const io = req.app.get('io');
        io.emit('newBid', newBid);

        res.status(201).json({ message: 'Bid placed successfully!', bid: newBid });
    } catch (err) {
        if (err.code === '23505') { // unique_violation (event_id, vendor_id) — race with the check above
            return res.status(409).json({ error: 'You have already placed a bid on this event.' });
        }
        console.error(err.message);
        res.status(500).json({ error: 'Server error while placing bid.' });
    }
});

// GET /api/bids/event/:eventId - Organizer views all bids for their specific event
router.get('/event/:eventId', authenticateUser, requireRole('organizer'), async (req, res) => {
    const { eventId } = req.params;
    const organizer_id = req.user.user_id;

    try {
        // Verify the event belongs to this organizer
        const eventCheck = await pool.query('SELECT organizer_id FROM events WHERE event_id = $1', [eventId]);
        if (eventCheck.rowCount === 0) {
            return res.status(404).json({ error: 'Event not found.' });
        }
        if (eventCheck.rows[0].organizer_id !== organizer_id) {
            return res.status(403).json({ error: 'Access forbidden. You do not own this event.' });
        }

        const result = await pool.query(
            `SELECT b.bid_id, b.proposed_price, b.status, b.created_at, b.notes, b.bid_categories,
                    u.user_id AS vendor_id, u.name AS vendor_name,
                    COALESCE(r.avg_rating, 0) AS vendor_rating,
                    COALESCE(r.rating_count, 0) AS vendor_rating_count
             FROM bids b
             JOIN users u ON b.vendor_id = u.user_id
             LEFT JOIN (
                 SELECT vendor_id, AVG(rating)::numeric(10,2) AS avg_rating, COUNT(*)::int AS rating_count
                 FROM vendor_ratings
                 GROUP BY vendor_id
             ) r ON r.vendor_id = u.user_id
             WHERE b.event_id = $1
             ORDER BY COALESCE(r.avg_rating, 0) DESC, b.proposed_price ASC`,
            [eventId]
        );
        res.status(200).json(result.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server error fetching bids.' });
    }
});

// PUT /api/bids/:bidId/accept - Organizer accepts a winning bid
router.put('/:bidId/accept', authenticateUser, requireRole('organizer'), async (req, res) => {
    const { bidId } = req.params;
    const organizer_id = req.user.user_id; // Securely derive identity from token

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Lock the bid row and derive event_id and bid_categories server-side
        const bidResult = await client.query(
            'SELECT event_id, bid_categories FROM bids WHERE bid_id = $1 FOR UPDATE',
            [bidId]
        );

        if (bidResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Bid not found.' });
        }

        const eventId = bidResult.rows[0].event_id;
        const acceptedCategories = bidResult.rows[0].bid_categories || [];

        const eventResult = await client.query(
            'SELECT organizer_id FROM events WHERE event_id = $1 FOR UPDATE',
            [eventId]
        );

        if (eventResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Event not found.' });
        }

        if (String(eventResult.rows[0].organizer_id) !== String(organizer_id)) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Unauthorized to accept bids for this event.' });
        }

        // 1. Accept the target bid
        await client.query("UPDATE bids SET status = 'accepted' WHERE bid_id = $1", [bidId]);

        // 2. Reject ONLY other pending bids that overlap with the accepted categories
        if (acceptedCategories.length > 0) {
            await client.query(`
                UPDATE bids 
                SET status = 'rejected' 
                WHERE event_id = $1 AND bid_id != $2 AND status = 'pending' 
                AND EXISTS (
                    SELECT 1 FROM jsonb_array_elements_text(bid_categories) cat 
                    WHERE cat = ANY($3::text[])
                )
            `, [eventId, bidId, acceptedCategories]);
        }

        // 3. Check if all required categories are now fulfilled
        const eventPlanResult = await client.query('SELECT ai_infrastructure_plan FROM events WHERE event_id = $1', [eventId]);
        const eventPlan = eventPlanResult.rows[0]?.ai_infrastructure_plan || {};
        const requiredCategories = (eventPlan.categories || []).map(c => c.name);

        const acceptedBidsResult = await client.query("SELECT bid_categories FROM bids WHERE event_id = $1 AND status = 'accepted'", [eventId]);
        const fulfilledCategories = new Set();
        for (const row of acceptedBidsResult.rows) {
            for (const cat of (row.bid_categories || [])) {
                fulfilledCategories.add(cat);
            }
        }

        const isFullyBooked = requiredCategories.every(cat => fulfilledCategories.has(cat));
        
        if (isFullyBooked) {
            await client.query("UPDATE events SET status = 'closed' WHERE event_id = $1", [eventId]);
        }

        await client.query('COMMIT');
        res.status(200).json({ message: 'Bid accepted and event closed!' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err.message);
        res.status(500).json({ error: 'Server error accepting bid.' });
    } finally {
        client.release();
    }
});

// GET /api/bids/vendor - Vendor views their own placed bids
router.get('/vendor', authenticateUser, requireRole('vendor'), async (req, res) => {
    const vendor_id = req.user.user_id;

    try {
        const result = await pool.query(
            `SELECT b.bid_id, b.event_id, b.proposed_price, b.notes, b.status, b.bid_categories, e.event_type, e.location 
             FROM bids b 
             JOIN events e ON b.event_id = e.event_id 
             WHERE b.vendor_id = $1 
             ORDER BY b.created_at DESC`,
            [vendor_id]
        );
        res.status(200).json(result.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server error fetching vendor bids.' });
    }
});

module.exports = router;
