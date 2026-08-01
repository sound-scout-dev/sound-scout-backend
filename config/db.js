// config/db.js
const { Pool } = require('pg');
require('dotenv').config();

const isProduction = process.env.NODE_ENV === 'production' || !!process.env.DATABASE_URL;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    user: process.env.DATABASE_URL ? undefined : process.env.DB_USER,
    password: process.env.DATABASE_URL ? undefined : process.env.DB_PASSWORD,
    host: process.env.DATABASE_URL ? undefined : process.env.DB_HOST,
    port: process.env.DATABASE_URL ? undefined : process.env.DB_PORT,
    database: process.env.DATABASE_URL ? undefined : process.env.DB_DATABASE,
    ssl: isProduction ? { rejectUnauthorized: false } : false
});

pool.on('connect', () => {
    console.log('🔗 Connected to the PostgreSQL database.');
});

// Auto-run schema migrations
pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_code VARCHAR(50);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT FALSE;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS district VARCHAR(255);
    UPDATE users SET phone = '0703252870' WHERE (phone IS NULL OR phone = '') AND LOWER(role) = 'vendor';
    UPDATE users SET phone = '0711475700' WHERE (phone IS NULL OR phone = '') AND LOWER(role) = 'organizer';
    UPDATE rental_items SET qty = 2 WHERE qty <= 0 OR qty IS NULL;

    CREATE TABLE IF NOT EXISTS rental_items (
        item_id SERIAL PRIMARY KEY,
        vendor_id INT REFERENCES users(user_id) ON DELETE CASCADE,
        vendor_name VARCHAR(255),
        equipment_summary TEXT NOT NULL,
        price_per_day NUMERIC NOT NULL,
        qty INT DEFAULT 1,
        category VARCHAR(100) DEFAULT 'Audio',
        location VARCHAR(255),
        photo_url TEXT,
        availability VARCHAR(50) DEFAULT 'now',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS rental_bookings (
        booking_id SERIAL PRIMARY KEY,
        item_id INT REFERENCES rental_items(item_id) ON DELETE CASCADE,
        renter_id INT REFERENCES users(user_id) ON DELETE SET NULL,
        renter_name VARCHAR(255),
        qty_booked INT DEFAULT 1,
        rental_days INT DEFAULT 1,
        total_price NUMERIC NOT NULL,
        deposit_paid NUMERIC NOT NULL,
        payment_mode VARCHAR(100) DEFAULT '50% Advance Escrow Deposit',
        status VARCHAR(50) DEFAULT 'confirmed',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
`).then(() => {
    console.log('✅ User, Event, and Rental schemas verified.');
}).catch(err => console.error('⚠️ DB Migration notice:', err.message));

pool.on('error', (err) => {
    console.error('❌ Unexpected error on idle client', err);
    process.exit(-1);
});

module.exports = pool;