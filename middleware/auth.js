const jwt = require('jsonwebtoken');
require('dotenv').config();
const { ACCESS_TOKEN_SECRET } = require('../config/secrets');

const authenticateUser = (req, res, next) => {
    let token = null;

    // 1. Check Authorization header (standard: Bearer <token>)
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.split(' ')[1];
    }

    // 2. If no header, check cookies (specifically for Web Clients)
    if (!token && req.cookies) {
        token = req.cookies.accessToken;
    }

    if (!token) {
        return res.status(401).json({ error: 'Access denied. No token provided.' });
    }

    try {
        const decoded = jwt.verify(token, ACCESS_TOKEN_SECRET);
        req.user = decoded; // { user_id, email, role }
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired access token.' });
    }
};

const requireRole = (role) => {
    return (req, res, next) => {
        if (!req.user || !req.user.role || req.user.role.toLowerCase() !== role.toLowerCase()) {
            return res.status(403).json({ error: `Access forbidden. Requires '${role}' role.` });
        }
        next();
    };
};

module.exports = {
    authenticateUser,
    requireRole
};
