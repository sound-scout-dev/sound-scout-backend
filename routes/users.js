const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// POST /api/users/register - Create a new user
router.post('/register', async (req, res) => {
    const { name, email, role, region } = req.body;

    try {
        const result = await pool.query(
            'INSERT INTO users (name, email, role, region) VALUES ($1, $2, $3, $4) RETURNING *',
            [name, email, role, region]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server error during user registration.' });
    }
});

module.exports = router;