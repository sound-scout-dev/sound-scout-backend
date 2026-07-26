// routes/bids.js
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticateUser, requireRole } = require('../middleware/auth');
const { sendWhatsAppMessage } = require('../services/whatsappClient');

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
            `SELECT b.bid_id, b.proposed_price, b.status, b.created_at, b.notes, b.bid_categories, b.payment_status, u.name AS vendor_name,
                    CASE WHEN b.status = 'accepted' AND b.payment_status = 'paid' THEN u.phone ELSE '' END AS vendor_phone 
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

        // Fetch details for WhatsApp notification in the background
        const detailsResult = await client.query(
            `SELECT u.phone AS vendor_phone, u.name AS vendor_name, e.event_type, e.location, org.name AS organizer_name, org.phone AS organizer_phone, b.proposed_price 
             FROM bids b 
             JOIN users u ON b.vendor_id = u.user_id 
             JOIN events e ON b.event_id = e.event_id 
             JOIN users org ON e.organizer_id = org.user_id 
             WHERE b.bid_id = $1`,
            [bidId]
        );

        await client.query('COMMIT');

        if (detailsResult.rowCount > 0) {
            const details = detailsResult.rows[0];
            const { vendor_phone, vendor_name, event_type, location, organizer_name, organizer_phone, proposed_price } = details;
            
            if (vendor_phone) {
                const message = `🎉 *SoundScout Bid Accepted!*\n\nDear *${vendor_name}*,\n\nWe are excited to inform you that your bid of *Rs. ${Number(proposed_price).toLocaleString()}* for the event *${event_type}* at *${location}* has been *ACCEPTED*!\n\nOrganizer details:\n👤 Name: *${organizer_name}*\n📞 Phone: *${organizer_phone || 'N/A'}*\n\nPlease log in to your SoundScout dashboard to coordinate further details.`;
                sendWhatsAppMessage(vendor_phone, message).catch(err => console.error("Error sending accept bid WhatsApp:", err));
            }
        }

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
            `SELECT b.bid_id, b.event_id, b.proposed_price, b.notes, b.status, b.bid_categories, e.event_type, e.location, u.name AS organizer_name,
                    CASE WHEN b.status = 'accepted' AND b.payment_status = 'paid' THEN u.phone ELSE '' END AS organizer_phone 
             FROM bids b 
             JOIN events e ON b.event_id = e.event_id 
             JOIN users u ON e.organizer_id = u.user_id 
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

// PUT /api/bids/:bidId/accept-and-pay - Organizer accepts a winning bid and performs escrow payment
router.put('/:bidId/accept-and-pay', authenticateUser, requireRole('organizer'), async (req, res) => {
    const { bidId } = req.params;
    const { transactionId } = req.body;
    const organizer_id = req.user.user_id;

    if (!transactionId) {
        return res.status(400).json({ error: 'transactionId is required.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Lock the bid row and fetch the proposed price
        const bidResult = await client.query(
            'SELECT event_id, proposed_price, bid_categories FROM bids WHERE bid_id = $1 FOR UPDATE',
            [bidId]
        );

        if (bidResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Bid not found.' });
        }

        const eventId = bidResult.rows[0].event_id;
        const proposedPrice = Number(bidResult.rows[0].proposed_price);
        const acceptedCategories = bidResult.rows[0].bid_categories || [];

        // Calculate 6% platform fee and deposit amount
        const platformFee = Number((proposedPrice * 0.06).toFixed(2));
        const depositAmount = platformFee; // The deposit charged is equal to the platform fee in this escrow flow

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

        // 1. Accept the target bid and set payment details
        await client.query(
            `UPDATE bids 
             SET status = 'accepted', 
                 payment_status = 'paid', 
                 platform_fee = $1, 
                 deposit_amount = $2, 
                 transaction_id = $3 
             WHERE bid_id = $4`,
            [platformFee, depositAmount, transactionId, bidId]
        );

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

        // Fetch details for WhatsApp notification in the background
        const detailsResult = await client.query(
            `SELECT u.phone AS vendor_phone, u.name AS vendor_name, e.event_type, e.location, org.name AS organizer_name, org.phone AS organizer_phone, b.proposed_price 
             FROM bids b 
             JOIN users u ON b.vendor_id = u.user_id 
             JOIN events e ON b.event_id = e.event_id 
             JOIN users org ON e.organizer_id = org.user_id 
             WHERE b.bid_id = $1`,
            [bidId]
        );

        await client.query('COMMIT');

        if (detailsResult.rowCount > 0) {
            const details = detailsResult.rows[0];
            const { vendor_phone, vendor_name, event_type, location, organizer_name, organizer_phone, proposed_price } = details;
            
            if (vendor_phone) {
                const message = `🎉 *SoundScout Bid Accepted & Escrow Paid!*\n\nDear *${vendor_name}*,\n\nWe are excited to inform you that your bid of *Rs. ${Number(proposed_price).toLocaleString()}* for the event *${event_type}* at *${location}* has been *ACCEPTED* and the platform escrow deposit has been paid successfully!\n\nOrganizer details:\n👤 Name: *${organizer_name}*\n📞 Phone: *${organizer_phone || 'N/A'}*\n\nDirect contact details are now unlocked on your dashboard. Let's coordinate!`;
                sendWhatsAppMessage(vendor_phone, message).catch(err => console.error("Error sending accept bid WhatsApp:", err));
            }
        }

        res.status(200).json({ message: 'Bid accepted, escrow deposit paid, and event updated successfully!' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err.message);
        res.status(500).json({ error: 'Server error during escrow payment and bid acceptance.' });
    } finally {
        client.release();
    }
});

module.exports = router;
