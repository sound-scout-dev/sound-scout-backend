// routes/feedback.js
// "Rate SoundScout" prompts -- platform feedback, not vendor reviews (see routes/ratings.js
// for that). Fired by the frontend after creating an event, placing a bid, and after an
// event finishes (final payment released).
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticateUser } = require('../middleware/auth');
const { validateBody } = require('../middleware/validate');
const schemas = require('../validation/schemas');

router.post('/', authenticateUser, validateBody(schemas.createAppFeedback), async (req, res) => {
    const { triggerType, referenceId, rating, comment } = req.body;
    const userId = req.user.user_id;

    try {
        const result = await pool.query(
            `INSERT INTO app_feedback (user_id, trigger_type, reference_id, rating, comment)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING feedback_id, trigger_type, reference_id, rating, comment, created_at`,
            [userId, triggerType, referenceId ?? null, rating, comment || null]
        );
        res.status(201).json({ message: 'Feedback submitted successfully.', feedback: result.rows[0] });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server error while submitting feedback.' });
    }
});

// GET /api/feedback/summary - aggregate rating + recent comments, for founders to check
// in on. Any authenticated user can view it for now (no admin role exists in this app yet).
router.get('/summary', authenticateUser, async (req, res) => {
    try {
        const summary = await pool.query(
            `SELECT COALESCE(AVG(rating), 0)::numeric(10,2) AS avg_rating, COUNT(*)::int AS feedback_count
             FROM app_feedback`
        );

        const byTrigger = await pool.query(
            `SELECT trigger_type, COALESCE(AVG(rating), 0)::numeric(10,2) AS avg_rating, COUNT(*)::int AS feedback_count
             FROM app_feedback GROUP BY trigger_type`
        );

        const recent = await pool.query(
            `SELECT f.trigger_type, f.rating, f.comment, f.created_at, u.name AS user_name
             FROM app_feedback f
             JOIN users u ON f.user_id = u.user_id
             ORDER BY f.created_at DESC
             LIMIT 50`
        );

        res.status(200).json({
            avg_rating: Number(summary.rows[0].avg_rating),
            feedback_count: summary.rows[0].feedback_count,
            by_trigger: byTrigger.rows,
            recent: recent.rows,
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server error fetching feedback summary.' });
    }
});

module.exports = router;
