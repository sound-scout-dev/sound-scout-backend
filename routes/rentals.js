const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticateUser, requireRole } = require('../middleware/auth');
const axios = require('axios');

// Active SSE clients for real-time quantity updates
let sseClients = [];

// Helper to broadcast inventory changes to all connected frontend clients
function broadcastInventoryUpdate(data) {
    sseClients.forEach(client => {
        try {
            client.res.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch (e) {
            console.warn("SSE broadcast write error:", e.message);
        }
    });
}

// GET /api/rentals/stream - Server-Sent Events (SSE) real-time inventory stream
router.get('/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const clientId = Date.now();
    const newClient = { id: clientId, res };
    sseClients.push(newClient);

    req.on('close', () => {
        sseClients = sseClients.filter(c => c.id !== clientId);
    });
});

function normPhone(phone) {
    const str = String(phone || '');
    if (!str || str === 'null' || str === 'undefined') return null;
    if (str.includes('@lid')) return null;
    let n = str.replace(/\D/g, '');
    if (n.length >= 14) return null;  // Baileys LID — reject
    if (n.startsWith('0')) n = '94' + n.substring(1);
    else if (n.length === 9 && n.startsWith('7')) n = '94' + n;
    if (n.length < 9 || n.length > 13) return null;
    return n;
}

// GET /api/rentals - Fetch all active instant rental items
router.get('/', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    const { category, location } = req.query;

    try {
        let queryStr = 'SELECT r.*, u.phone AS vendor_phone FROM rental_items r LEFT JOIN users u ON r.vendor_id = u.user_id WHERE 1=1';
        let queryParams = [];

        if (category && category !== 'All') {
            queryParams.push(category);
            queryStr += ` AND r.category = $${queryParams.length}`;
        }

        if (location && location.trim() !== '') {
            queryParams.push(`%${location.trim()}%`);
            queryStr += ` AND r.location ILIKE $${queryParams.length}`;
        }

        queryStr += ' ORDER BY r.created_at DESC';

        const result = await pool.query(queryStr, queryParams);
        const formattedRows = result.rows.map(row => ({
            id: row.item_id,
            vendorId: row.vendor_id,
            vendorName: row.vendor_name,
            equipmentSummary: row.equipment_summary,
            pricePerDay: Number(row.price_per_day),
            qty: row.qty,
            category: row.category,
            location: row.location,
            photoUrl: row.photo_url,
            photos: row.photo_url ? [row.photo_url] : [],
            availability: row.qty <= 0 ? 'booked' : (row.availability || 'now'),
            rating: 5.0,
            vendorPhone: normPhone(row.vendor_phone)
        }));

        res.status(200).json(formattedRows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server error fetching rental items.' });
    }
});

// POST /api/rentals - Vendor lists a new instant rental item
router.post('/', authenticateUser, requireRole('vendor'), async (req, res) => {
    const { equipmentSummary, pricePerDay, qty, category, photoUrl } = req.body;
    const vendor_id = req.user.user_id;

    if (!equipmentSummary || !pricePerDay) {
        return res.status(400).json({ error: 'Equipment summary and price per day are required.' });
    }

    try {
        const vendorRes = await pool.query('SELECT name, region, phone FROM users WHERE user_id = $1', [vendor_id]);
        const vendorName = vendorRes.rows[0]?.name || 'Rental Vendor';
        const location = vendorRes.rows[0]?.region || 'Colombo';
        const vendorPhone = normPhone(vendorRes.rows[0]?.phone);

        const result = await pool.query(
            `INSERT INTO rental_items (vendor_id, vendor_name, equipment_summary, price_per_day, qty, category, location, photo_url)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [
                vendor_id,
                vendorName,
                equipmentSummary,
                Number(pricePerDay) || 0,
                Math.max(1, Number(qty) || 1),
                category || 'Audio',
                location,
                photoUrl || null
            ]
        );

        const newItem = result.rows[0];
        const formattedItem = {
            id: newItem.item_id,
            vendorId: newItem.vendor_id,
            vendorName: newItem.vendor_name,
            equipmentSummary: newItem.equipment_summary,
            pricePerDay: Number(newItem.price_per_day),
            qty: newItem.qty,
            category: newItem.category,
            location: newItem.location,
            photoUrl: newItem.photo_url,
            photos: newItem.photo_url ? [newItem.photo_url] : [],
            availability: 'now',
            vendorPhone: vendorPhone
        };

        // Broadcast to connected web socket/SSE clients
        broadcastInventoryUpdate({ type: 'ITEM_ADDED', item: formattedItem });

        res.status(201).json(formattedItem);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server error listing rental item.' });
    }
});

// POST /api/rentals/:id/book - Organizer books instant rental item & triggers WhatsApp vendor notification
router.post('/:id/book', authenticateUser, async (req, res) => {
    const itemId = req.params.id;
    const renter_id = req.user.user_id;
    const { qtyToBook = 1, rentalDays = 1, paymentMode = '50% Advance Escrow Deposit' } = req.body;

    try {
        // Fetch item details
        const itemResult = await pool.query(
            'SELECT r.*, u.phone AS vendor_phone, u.name AS vendor_name FROM rental_items r JOIN users u ON r.vendor_id = u.user_id WHERE r.item_id = $1',
            [itemId]
        );

        if (itemResult.rows.length === 0) {
            return res.status(404).json({ error: 'Rental item not found.' });
        }

        const item = itemResult.rows[0];
        const requestedQty = Math.max(1, Number(qtyToBook) || 1);
        const currentAvailableQty = Math.max(1, Number(item.qty) || 1);

        // Fetch renter details
        const renterResult = await pool.query('SELECT name, phone, email FROM users WHERE user_id = $1', [renter_id]);
        const renter = renterResult.rows[0];

        // Financial calculations
        const subtotal = Number(item.price_per_day) * requestedQty * Number(rentalDays);
        const insuranceFee = Math.round(subtotal * 0.05);
        const totalPrice = subtotal + insuranceFee;
        const depositPaid = paymentMode.includes('100%') ? totalPrice : Math.round(totalPrice * 0.5);

        // Deduct inventory quantity safely
        const updatedItemRes = await pool.query(
            'UPDATE rental_items SET qty = GREATEST(0, $1 - $2) WHERE item_id = $3 RETURNING *',
            [currentAvailableQty, requestedQty, itemId]
        );

        // Insert rental booking record
        const bookingRes = await pool.query(
            `INSERT INTO rental_bookings (item_id, renter_id, renter_name, qty_booked, rental_days, total_price, deposit_paid, payment_mode)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [itemId, renter_id, renter?.name || 'Organizer', requestedQty, rentalDays, totalPrice, depositPaid, paymentMode]
        );

        const newBooking = bookingRes.rows[0];
        const newQty = updatedItemRes.rows[0].qty;

        // Broadcast real-time SSE quantity update to all active browsers
        broadcastInventoryUpdate({
            type: 'QUANTITY_UPDATED',
            itemId: Number(itemId),
            newQty: newQty
        });

        // Send automated WhatsApp notification to the vendor
        let rawPhone = item.vendor_phone;
        if (!rawPhone && item.vendor_id) {
            try {
                const vRes = await pool.query('SELECT phone FROM users WHERE user_id = $1', [item.vendor_id]);
                rawPhone = vRes.rows[0]?.phone;
            } catch (e) {}
        }

        const targetVendorPhone = normPhone(rawPhone);

        if (targetVendorPhone) {
            try {
                const cleanRenterPhone = renter?.phone ? normPhone(renter.phone) : '';
                const organizerContactUrl = cleanRenterPhone ? `https://api.whatsapp.com/send?phone=${cleanRenterPhone}` : '#';
                
                const vendorMsg = `🎉 *New Instant Rental Booking!*\n\n` +
                    `*Item:* ${item.equipment_summary}\n` +
                    `*Renter:* ${renter?.name || 'SoundScout Organizer'}\n` +
                    `*Qty Booked:* ${requestedQty} units (${rentalDays} days)\n` +
                    `*Escrow Deposit:* LKR ${depositPaid.toLocaleString()}\n` +
                    `*Status:* Confirmed & Paid in Escrow\n\n` +
                    `📲 *Contact Organizer on WhatsApp:* ${organizerContactUrl}`;

                const workerUrl = process.env.WHATSAPP_WORKER_URL || 'https://sound-scout-whatsapp-worker.onrender.com';
                const workerSecret = process.env.WORKER_SECRET || 'super_secret_key';

                console.log(`📡 Dispatching booking alert to WhatsApp worker for vendor phone: ${targetVendorPhone}`);
                axios.post(`${workerUrl}/api/send-message`, {
                    secret: workerSecret,
                    phone: targetVendorPhone,
                    message: vendorMsg
                }, { timeout: 8000 }).catch(() => {
                    return axios.post(`${workerUrl}/api/queue-otp`, {
                        secret: workerSecret,
                        phone: targetVendorPhone,
                        message: vendorMsg
                    }, { timeout: 8000 });
                }).catch(e => console.warn("Could not dispatch WhatsApp vendor alert:", e.message));
            } catch (waErr) {
                console.warn("Could not process WhatsApp vendor notification:", waErr.message);
            }
        }

        res.status(200).json({
            message: 'Rental booking confirmed!',
            booking: newBooking,
            remainingQty: newQty,
            vendorPhone: targetVendorPhone,
            vendorName: item.vendor_name
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server error confirming rental booking.' });
    }
});

// GET /api/rentals/my-bookings - Fetch confirmed bookings for vendor or organizer
router.get('/my-bookings', authenticateUser, async (req, res) => {
    const userId = req.user.user_id;

    try {
        const result = await pool.query(
            `SELECT b.*, r.equipment_summary, r.vendor_name, 
                    u_vendor.phone AS vendor_phone, 
                    u_renter.phone AS renter_phone, 
                    u_renter.email AS renter_email
             FROM rental_bookings b
             JOIN rental_items r ON b.item_id = r.item_id
             LEFT JOIN users u_vendor ON r.vendor_id = u_vendor.user_id
             LEFT JOIN users u_renter ON b.renter_id = u_renter.user_id
             WHERE b.renter_id = $1 OR r.vendor_id = $1
             ORDER BY b.created_at DESC`,
            [userId]
        );

        const formattedBookings = result.rows.map(b => ({
            ...b,
            vendor_phone: b.vendor_phone ? normPhone(b.vendor_phone) : '',
            renter_phone: b.renter_phone ? normPhone(b.renter_phone) : ''
        }));

        res.status(200).json(formattedBookings);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server error fetching bookings.' });
    }
});

module.exports = router;
