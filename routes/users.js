const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'soundscout_access_secret_12345';
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'soundscout_refresh_secret_12345';
const SALT_ROUNDS = 10;

// Helper to hash token before storing in database (adds database-leak protection)
function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

// POST /api/users/register - Create a new user with password hashing
router.post('/register', async (req, res) => {
    const { name, email, role, region, password } = req.body;

    if (!name || !email || !role || !password) {
        return res.status(400).json({ error: 'Name, email, role, and password are required.' });
    }

    try {
        // Hash password before saving
        const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

        const result = await pool.query(
            `INSERT INTO users (name, email, role, region, password_hash) 
             VALUES ($1, $2, $3, $4, $5) RETURNING user_id, name, email, role, region`,
            [name, email, role, region, passwordHash]
        );
        const user = result.rows[0];

        const accessToken = jwt.sign(
            { user_id: user.user_id, email: user.email, role: user.role },
            ACCESS_TOKEN_SECRET,
            { expiresIn: '15m' }
        );
        const refreshToken = jwt.sign(
            { user_id: user.user_id },
            REFRESH_TOKEN_SECRET,
            { expiresIn: '7d' }
        );

        const hashedRefreshToken = hashToken(refreshToken);
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); 

        await pool.query(
            'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
            [user.user_id, hashedRefreshToken, expiresAt]
        );

        res.cookie('refreshToken', refreshToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'Lax',
            maxAge: 7 * 24 * 60 * 60 * 1000
        });

        res.cookie('accessToken', accessToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'Lax',
            maxAge: 15 * 60 * 1000
        });

        res.status(201).json({
            message: 'Registration successful!',
            user: user,
            accessToken,
            refreshToken
        });
    } catch (err) {
        console.error(err.message);
        if (err.code === '23505') { // Unique constraint violation (e.g. duplicate email)
            return res.status(400).json({ error: 'Email already registered.' });
        }
        res.status(500).json({ error: 'Server error during user registration.' });
    }
});

// POST /api/users/login - Authenticate user and issue rotated tokens
router.post('/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required.' });
    }

    try {
        // Check if user exists
        const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userResult.rowCount === 0) {
            return res.status(401).json({ error: 'Invalid credentials.' });
        }

        const user = userResult.rows[0];

        // Compare password hashes
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(401).json({ error: 'Invalid credentials.' });
        }

        // Generate short-lived Access Token & long-lived Refresh Token
        const accessToken = jwt.sign(
            { user_id: user.user_id, email: user.email, role: user.role },
            ACCESS_TOKEN_SECRET,
            { expiresIn: '15m' }
        );

        const refreshToken = jwt.sign(
            { user_id: user.user_id },
            REFRESH_TOKEN_SECRET,
            { expiresIn: '7d' }
        );

        // Store the hashed refresh token in database for rotation/revocation tracking
        const hashedRefreshToken = hashToken(refreshToken);
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days from now

        await pool.query(
            'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
            [user.user_id, hashedRefreshToken, expiresAt]
        );

        // Set refresh token in HTTP-only cookie (Web client security)
        res.cookie('refreshToken', refreshToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'Lax',
            maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
        });

        // Set access token in HTTP-only cookie as well (optional but helpful fallback)
        res.cookie('accessToken', accessToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'Lax',
            maxAge: 15 * 60 * 1000 // 15 mins
        });

        // Return tokens in body as well (Mobile client key storage requirement)
        res.status(200).json({
            message: 'Login successful!',
            user: {
                user_id: user.user_id,
                name: user.name,
                email: user.email,
                role: user.role,
                region: user.region
            },
            accessToken,
            refreshToken
        });

    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server error during login.' });
    }
});

// POST /api/users/refresh - Rotate token pair (mitigates replay attacks)
router.post('/refresh', async (req, res) => {
    let refreshToken = null;

    // Retrieve token from cookies or request body
    if (req.cookies && req.cookies.refreshToken) {
        refreshToken = req.cookies.refreshToken;
    } else if (req.body && req.body.refreshToken) {
        refreshToken = req.body.refreshToken;
    }

    if (!refreshToken) {
        return res.status(401).json({ error: 'Refresh token is required.' });
    }

    try {
        const hashedToken = hashToken(refreshToken);

        // Verify the refresh token exists in DB
        const tokenResult = await pool.query(
            'SELECT * FROM refresh_tokens WHERE token_hash = $1',
            [hashedToken]
        );

        if (tokenResult.rowCount === 0) {
            // Replay attack / theft check: If the token is verified but not in DB, 
            // the refresh token was reused. We revoke all tokens for this user session.
            try {
                const decoded = jwt.verify(refreshToken, REFRESH_TOKEN_SECRET);
                await pool.query('DELETE FROM refresh_tokens WHERE user_id = $1', [decoded.user_id]);
                res.clearCookie('refreshToken');
                res.clearCookie('accessToken');
            } catch (_) { }

            return res.status(403).json({ error: 'Session compromised. Please re-authenticate.' });
        }

        const storedToken = tokenResult.rows[0];

        // Check if token has expired in DB
        if (new Date() > new Date(storedToken.expires_at)) {
            await pool.query('DELETE FROM refresh_tokens WHERE token_hash = $1', [hashedToken]);
            return res.status(403).json({ error: 'Refresh token expired. Please login again.' });
        }

        // Verify signature & extract payload
        const decoded = jwt.verify(refreshToken, REFRESH_TOKEN_SECRET);

        // Fetch current user details to include in new access token
        const userResult = await pool.query(
            'SELECT user_id, email, role, name, region FROM users WHERE user_id = $1',
            [decoded.user_id]
        );

        if (userResult.rowCount === 0) {
            return res.status(404).json({ error: 'User not found.' });
        }

        const user = userResult.rows[0];

        // ROTATE TOKENS: Generate new pair
        const newAccessToken = jwt.sign(
            { user_id: user.user_id, email: user.email, role: user.role },
            ACCESS_TOKEN_SECRET,
            { expiresIn: '15m' }
        );

        const newRefreshToken = jwt.sign(
            { user_id: user.user_id },
            REFRESH_TOKEN_SECRET,
            { expiresIn: '7d' }
        );

        const newHashedToken = hashToken(newRefreshToken);
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

        // Transaction to delete old and insert new refresh token (atomic swap)
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('DELETE FROM refresh_tokens WHERE token_hash = $1', [hashedToken]);
            await client.query(
                'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
                [user.user_id, newHashedToken, expiresAt]
            );
            await client.query('COMMIT');
        } catch (txnErr) {
            await client.query('ROLLBACK');
            throw txnErr;
        } finally {
            client.release();
        }

        // Set cookies with new values
        res.cookie('refreshToken', newRefreshToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'Lax',
            maxAge: 7 * 24 * 60 * 60 * 1000
        });

        res.cookie('accessToken', newAccessToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'Lax',
            maxAge: 15 * 60 * 1000
        });

        // Send new tokens to client
        res.status(200).json({
            accessToken: newAccessToken,
            refreshToken: newRefreshToken
        });

    } catch (err) {
        console.error(err.message);
        res.status(403).json({ error: 'Forbidden. Invalid refresh token.' });
    }
});

// POST /api/users/logout - Revoke refresh token and clear cookies
router.post('/logout', async (req, res) => {
    let refreshToken = null;

    if (req.cookies && req.cookies.refreshToken) {
        refreshToken = req.cookies.refreshToken;
    } else if (req.body && req.body.refreshToken) {
        refreshToken = req.body.refreshToken;
    }

    try {
        if (refreshToken) {
            const hashedToken = hashToken(refreshToken);
            // Delete refresh token from DB (revoke it)
            await pool.query('DELETE FROM refresh_tokens WHERE token_hash = $1', [hashedToken]);
        }

        // Clear cookies
        res.clearCookie('refreshToken');
        res.clearCookie('accessToken');

        res.status(200).json({ message: 'Logged out successfully.' });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server error during logout.' });
    }
});

// PUT /api/users/profile - Update user profile details
router.put('/profile', async (req, res) => {
    const authHeader = req.headers.authorization;
    let token = null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.split(' ')[1];
    } else if (req.cookies && req.cookies.accessToken) {
        token = req.cookies.accessToken;
    }

    if (!token) {
        return res.status(401).json({ error: 'Unauthorized.' });
    }

    try {
        const decoded = jwt.verify(token, ACCESS_TOKEN_SECRET);
        const { name, email, region, password } = req.body;

        if (!name || !email) {
            return res.status(400).json({ error: 'Name and email are required.' });
        }

        let result;
        if (password && password.trim() !== '') {
            const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
            result = await pool.query(
                `UPDATE users SET name = $1, email = $2, region = $3, password_hash = $4 
                 WHERE user_id = $5 RETURNING user_id, name, email, role, region`,
                [name, email, region, passwordHash, decoded.user_id]
            );
        } else {
            result = await pool.query(
                `UPDATE users SET name = $1, email = $2, region = $3 
                 WHERE user_id = $4 RETURNING user_id, name, email, role, region`,
                [name, email, region, decoded.user_id]
            );
        }

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'User not found.' });
        }

        res.status(200).json(result.rows[0]);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server error updating profile.' });
    }
});

module.exports = router;