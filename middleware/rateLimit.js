// middleware/rateLimit.js
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;

// Applied to every request. Generous, mainly to blunt scraping/DoS-by-volume rather
// than to constrain normal usage.
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please try again later.' }
});

// Tight limiter for endpoints that are directly brute-forceable (password guessing,
// OTP guessing, account enumeration via forgot-password). Keyed on IP + email so one
// bad actor can't lock out every user sharing that IP (NAT/office networks), while a
// single attacker hammering one account is still capped.
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `${ipKeyGenerator(req.ip)}:${(req.body?.email || '').toLowerCase()}`,
    message: { error: 'Too many attempts. Please try again in 15 minutes.' }
});

// OTP/verification-code endpoints get a slightly looser cap since resend is a
// legitimate user action, but still bounded well below brute-force viability for a
// 6-character code space.
const otpLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `${ipKeyGenerator(req.ip)}:${(req.body?.email || req.params?.code || '').toLowerCase()}`,
    message: { error: 'Too many attempts. Please try again in 10 minutes.' }
});

module.exports = { globalLimiter, authLimiter, otpLimiter };
