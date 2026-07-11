// routes/bids.js
const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// POST /api/bids - Vendor submits a bid for an event
router.post('/', async (req, res) => {
    const { event_id, vendor_id, proposed_price } = req.body;

    if (!event_id || !vendor_id || proposed_price === undefined) {
        return res.status(400).json({ error: 'event_id, vendor_id and proposed_price are required.' });
    }

    const price = Number(proposed_price);
    if (!Number.isFinite(price) || price <= 0) {
        return res.status(400).json({ error: 'proposed_price must be a positive number.' });
    }

    try {
        const result = await pool.query(
            `INSERT INTO bids (event_id, vendor_id, proposed_price) 
       VALUES ($1, $2, $3) RETURNING *`,
            [event_id, vendor_id, price]
        );

        const newBid = result.rows[0];

        // --- NEW WEB SOCKET EMIT ---
        // Access the io instance attached to the app and emit the event globally
        const io = req.app.get('io');
        io.emit('newBid', newBid);

        res.status(201).json({ message: 'Bid placed successfully!', bid: newBid });
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
    const { organizer_id } = req.body;

    if (!organizer_id) {
        return res.status(400).json({ error: 'organizer_id is required.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Lock the bid row and derive event_id server-side (avoid trusting client input)
        const bidResult = await client.query(
            'SELECT event_id FROM bids WHERE bid_id = $1 FOR UPDATE',
            [bidId]
        );

        if (bidResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Bid not found.' });
        }

        const eventId = bidResult.rows[0].event_id;
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

        await client.query("UPDATE bids SET status = 'accepted' WHERE bid_id = $1", [bidId]);
        await client.query("UPDATE bids SET status = 'rejected' WHERE event_id = $1 AND bid_id != $2", [eventId, bidId]);
        await client.query("UPDATE events SET status = 'closed' WHERE event_id = $1", [eventId]);

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

module.exports = router;
