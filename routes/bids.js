const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// POST /api/bids - Vendor submits a bid for an event
router.post('/', async (req, res) => {
    const { event_id, vendor_id, proposed_price } = req.body;

    try {
        const result = await pool.query(
            `INSERT INTO bids (event_id, vendor_id, proposed_price) 
       VALUES ($1, $2, $3) RETURNING *`,
            [event_id, vendor_id, proposed_price]
        );
        res.status(201).json({ message: 'Bid placed successfully!', bid: result.rows[0] });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server error while placing bid.' });
    }
});

// GET /api/bids/event/:eventId - Organizer views all bids for their specific event
router.get('/event/:eventId', async (req, res) => {
    const { eventId } = req.params;

    try {
        const result = await pool.query(
            `SELECT b.bid_id, b.proposed_price, b.status, b.created_at, u.name AS vendor_name 
       FROM bids b 
       JOIN users u ON b.vendor_id = u.user_id 
       WHERE b.event_id = $1 
       ORDER BY b.proposed_price ASC`,
            [eventId]
        );
        res.status(200).json(result.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server error fetching bids.' });
    }
});

// PUT /api/bids/:bidId/accept - Organizer accepts a winning bid
router.put('/:bidId/accept', async (req, res) => {
    const { bidId } = req.params;
    const { event_id } = req.body; // Need event ID to close the event

    try {
        // Start a SQL transaction to update both tables safely
        await pool.query('BEGIN');

        // 1. Mark this specific bid as accepted
        await pool.query("UPDATE bids SET status = 'accepted' WHERE bid_id = $1", [bidId]);

        // 2. Mark all other bids for this event as rejected
        await pool.query("UPDATE bids SET status = 'rejected' WHERE event_id = $1 AND bid_id != $2", [event_id, bidId]);

        // 3. Update the event status to closed
        await pool.query("UPDATE events SET status = 'closed' WHERE event_id = $1", [event_id]);

        await pool.query('COMMIT');
        res.status(200).json({ message: 'Bid accepted and event closed!' });
    } catch (err) {
        await pool.query('ROLLBACK');
        console.error(err.message);
        res.status(500).json({ error: 'Server error accepting bid.' });
    }
});

module.exports = router;