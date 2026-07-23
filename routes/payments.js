// routes/payments.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('../config/db');
const { authenticateUser, requireRole } = require('../middleware/auth');

const PAYHERE_MERCHANT_ID = process.env.PAYHERE_MERCHANT_ID;
const PAYHERE_MERCHANT_SECRET = process.env.PAYHERE_MERCHANT_SECRET;
const PAYHERE_MODE = process.env.PAYHERE_MODE || 'sandbox';
const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || 'http://localhost:5173';
const BACKEND_BASE_URL = process.env.BACKEND_BASE_URL || 'http://localhost:5000';

const PAYHERE_CHECKOUT_URL = PAYHERE_MODE === 'live'
    ? 'https://www.payhere.lk/pay/checkout'
    : 'https://sandbox.payhere.lk/pay/checkout';

function md5(input) {
    return crypto.createHash('md5').update(input).digest('hex');
}

// PayHere's hash formula: MD5(merchant_id + order_id + amount + currency + MD5(merchant_secret))
// uppercased at each MD5 step. Amount must be a plain 2-decimal string, no thousands separators.
function generateHash(orderId, amount) {
    const formattedAmount = Number(amount).toFixed(2);
    const secretHash = md5(PAYHERE_MERCHANT_SECRET).toUpperCase();
    return md5(`${PAYHERE_MERCHANT_ID}${orderId}${formattedAmount}LKR${secretHash}`).toUpperCase();
}

// POST /api/payments/initiate - Organizer starts paying for an accepted bid.
// Returns the fields the frontend needs to POST straight to PayHere's hosted checkout.
router.post('/initiate', authenticateUser, requireRole('organizer'), async (req, res) => {
    const { bid_id } = req.body;
    const organizer_id = req.user.user_id;

    if (!PAYHERE_MERCHANT_ID || !PAYHERE_MERCHANT_SECRET) {
        return res.status(503).json({ error: 'Payment gateway is not configured yet. Set PAYHERE_MERCHANT_ID and PAYHERE_MERCHANT_SECRET in .env.' });
    }

    if (!bid_id) {
        return res.status(400).json({ error: 'bid_id is required.' });
    }

    try {
        const bidResult = await pool.query(
            `SELECT b.bid_id, b.event_id, b.vendor_id, b.proposed_price, b.status, e.organizer_id, e.event_type
             FROM bids b JOIN events e ON b.event_id = e.event_id
             WHERE b.bid_id = $1`,
            [bid_id]
        );

        if (bidResult.rowCount === 0) {
            return res.status(404).json({ error: 'Bid not found.' });
        }

        const bid = bidResult.rows[0];

        if (bid.organizer_id !== organizer_id) {
            return res.status(403).json({ error: 'Access forbidden. You do not own this event.' });
        }

        if (bid.status !== 'accepted') {
            return res.status(400).json({ error: 'Only accepted bids can be paid for.' });
        }

        // Reuse the existing payment row for this bid instead of creating duplicates on retry
        const existing = await pool.query('SELECT * FROM payments WHERE bid_id = $1', [bid_id]);
        if (existing.rowCount > 0 && existing.rows[0].status === 'completed') {
            return res.status(409).json({ error: 'This bid has already been paid.' });
        }

        const organizerResult = await pool.query('SELECT name, email FROM users WHERE user_id = $1', [organizer_id]);
        const organizer = organizerResult.rows[0];
        const [firstName, ...rest] = (organizer.name || 'Organizer').trim().split(' ');
        const lastName = rest.join(' ') || '.';

        const amount = Number(bid.proposed_price);
        let payment;
        if (existing.rowCount > 0) {
            payment = existing.rows[0];
        } else {
            const orderId = `SS-${bid_id}-${Date.now()}`;
            const insertResult = await pool.query(
                `INSERT INTO payments (bid_id, event_id, organizer_id, vendor_id, amount, order_id)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
                [bid_id, bid.event_id, organizer_id, bid.vendor_id, amount, orderId]
            );
            payment = insertResult.rows[0];
        }

        const hash = generateHash(payment.order_id, payment.amount);

        res.status(200).json({
            checkout_url: PAYHERE_CHECKOUT_URL,
            fields: {
                merchant_id: PAYHERE_MERCHANT_ID,
                return_url: `${FRONTEND_BASE_URL}/organizer/payments/${payment.payment_id}/return`,
                cancel_url: `${FRONTEND_BASE_URL}/organizer/payments/${payment.payment_id}/cancel`,
                notify_url: `${BACKEND_BASE_URL}/api/payments/notify`,
                order_id: payment.order_id,
                items: `SoundScout booking - ${bid.event_type}`,
                currency: 'LKR',
                amount: Number(payment.amount).toFixed(2),
                first_name: firstName,
                last_name: lastName,
                email: organizer.email,
                // PayHere requires these fields but this app doesn't collect them yet —
                // sandbox mode accepts placeholders; swap for real profile fields before going live.
                phone: '0770000000',
                address: 'No. 1, Main Street',
                city: 'Colombo',
                country: 'Sri Lanka',
                hash,
            }
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server error while initiating payment.' });
    }
});

// POST /api/payments/notify - PayHere server-to-server webhook.
// No auth (PayHere calls this directly) — trust is established via md5sig instead.
// NOTE: PayHere's servers can't reach localhost directly; testing this route for real
// requires tunneling it (e.g. ngrok) and pointing PAYHERE's sandbox dashboard / this
// service's notify_url at the public tunnel URL.
router.post('/notify', express.urlencoded({ extended: true }), async (req, res) => {
    try {
        const { merchant_id, order_id, payhere_amount, payhere_currency, status_code, md5sig, payment_id } = req.body;

        const secretHash = md5(PAYHERE_MERCHANT_SECRET).toUpperCase();
        const localSig = md5(`${merchant_id}${order_id}${payhere_amount}${payhere_currency}${status_code}${secretHash}`).toUpperCase();

        if (localSig !== md5sig) {
            console.error('PayHere notify: signature mismatch for order', order_id);
            return res.status(400).send('Invalid signature');
        }

        let newStatus = 'pending';
        if (status_code === '2') newStatus = 'completed';
        else if (status_code === '-1') newStatus = 'cancelled';
        else if (status_code === '-2' || status_code === '-3') newStatus = 'failed';

        await pool.query(
            `UPDATE payments SET status = $1, gateway_payment_id = $2, updated_at = now() WHERE order_id = $3`,
            [newStatus, payment_id || null, order_id]
        );

        res.status(200).send('OK');
    } catch (err) {
        console.error('PayHere notify error:', err.message);
        res.status(500).send('Error');
    }
});

// GET /api/payments/:paymentId - Check payment status by payment id (used by the
// return/cancel redirect pages, which only know the payment id from the URL)
router.get('/:paymentId', authenticateUser, async (req, res) => {
    const { paymentId } = req.params;
    if (!/^\d+$/.test(paymentId)) {
        return res.status(400).json({ error: 'Invalid payment id.' });
    }
    try {
        const result = await pool.query('SELECT * FROM payments WHERE payment_id = $1', [paymentId]);
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Payment not found.' });
        }
        const payment = result.rows[0];
        if (payment.organizer_id !== req.user.user_id && payment.vendor_id !== req.user.user_id) {
            return res.status(403).json({ error: 'Access forbidden.' });
        }
        res.status(200).json(payment);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server error fetching payment.' });
    }
});

// GET /api/payments/bid/:bidId - Check payment status for a bid (organizer or the bidding vendor)
router.get('/bid/:bidId', authenticateUser, async (req, res) => {
    const { bidId } = req.params;
    try {
        const result = await pool.query('SELECT * FROM payments WHERE bid_id = $1', [bidId]);
        if (result.rowCount === 0) {
            return res.status(200).json({ status: 'not_started' });
        }
        const payment = result.rows[0];
        if (payment.organizer_id !== req.user.user_id && payment.vendor_id !== req.user.user_id) {
            return res.status(403).json({ error: 'Access forbidden.' });
        }
        res.status(200).json(payment);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server error fetching payment status.' });
    }
});

// PUT /api/payments/:paymentId/payout - Organizer marks the vendor as paid out.
// IMPORTANT: this does NOT move any real money. PayHere has no marketplace/Connect-style
// product for automatically routing funds to Sri Lankan vendors, so this just records
// that the platform/organizer settled with the vendor outside the app (bank transfer, etc).
router.put('/:paymentId/payout', authenticateUser, requireRole('organizer'), async (req, res) => {
    const { paymentId } = req.params;
    const organizer_id = req.user.user_id;

    try {
        const result = await pool.query(
            `UPDATE payments SET payout_status = 'completed', updated_at = now()
             WHERE payment_id = $1 AND organizer_id = $2 AND status = 'completed'
             RETURNING *`,
            [paymentId, organizer_id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Payment not found, unauthorized, or not yet collected from the organizer.' });
        }

        res.status(200).json({ message: 'Vendor payout marked as completed.', payment: result.rows[0] });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server error while updating payout status.' });
    }
});

module.exports = router;
