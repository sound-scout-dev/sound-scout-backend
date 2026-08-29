// routes/ratings.js
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticateUser, requireRole } = require('../middleware/auth');

// POST /api/ratings - Organizer rates a vendor after working with them on an event
router.post('/', authenticateUser, requireRole('organizer'), async (req, res) => {
    const { event_id, vendor_id, rating, review } = req.body;
    const organizer_id = req.user.user_id;

    if (!event_id || !vendor_id || rating === undefined) {
        return res.status(400).json({ error: 'event_id, vendor_id, and rating are required.' });
    }

    const ratingValue = Math.round(Number(rating));
    if (!Number.isFinite(ratingValue) || ratingValue < 1 || ratingValue > 5) {
        return res.status(400).json({ error: 'rating must be an integer between 1 and 5.' });
    }

    try {
        // Verify the event belongs to this organizer
        const eventCheck = await pool.query('SELECT organizer_id FROM events WHERE event_id = $1', [event_id]);
        if (eventCheck.rowCount === 0) {
            return res.status(404).json({ error: 'Event not found.' });
        }
        if (eventCheck.rows[0].organizer_id !== organizer_id) {
            return res.status(403).json({ error: 'Access forbidden. You do not own this event.' });
        }

        // Only allow rating a vendor the organizer actually accepted a bid from on this event
        const bidCheck = await pool.query(
            "SELECT 1 FROM bids WHERE event_id = $1 AND vendor_id = $2 AND status = 'accepted'",
            [event_id, vendor_id]
        );
        if (bidCheck.rowCount === 0) {
            return res.status(403).json({ error: 'You can only rate a vendor whose bid you accepted for this event.' });
        }

        // Upsert so an organizer can revise their rating for the same event/vendor pair
        const result = await pool.query(
            `INSERT INTO vendor_ratings (event_id, vendor_id, organizer_id, rating, review)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (event_id, vendor_id)
             DO UPDATE SET rating = EXCLUDED.rating, review = EXCLUDED.review, updated_at = now()
             RETURNING *`,
            [event_id, vendor_id, organizer_id, ratingValue, review || null]
        );

        res.status(201).json({ message: 'Rating submitted successfully.', rating: result.rows[0] });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server error while submitting rating.' });
    }
});

// GET /api/ratings/vendor/:vendorId - Public average rating summary for a vendor
router.get('/vendor/:vendorId', async (req, res) => {
    const { vendorId } = req.params;

    try {
        const summary = await pool.query(
            `SELECT COALESCE(AVG(rating), 0)::numeric(10,2) AS avg_rating, COUNT(*)::int AS rating_count
             FROM vendor_ratings WHERE vendor_id = $1`,
            [vendorId]
        );

        const reviews = await pool.query(
            `SELECT r.rating, r.review, r.created_at, e.event_type, e.location
             FROM vendor_ratings r
             JOIN events e ON r.event_id = e.event_id
             WHERE r.vendor_id = $1
             ORDER BY r.created_at DESC
             LIMIT 20`,
            [vendorId]
        );

        res.status(200).json({
            vendor_id: Number(vendorId),
            avg_rating: Number(summary.rows[0].avg_rating),
            rating_count: summary.rows[0].rating_count,
            reviews: reviews.rows
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server error fetching vendor rating.' });
    }
});

module.exports = router;
