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
    ssl: isProduction ? { rejectUnauthorized: false } : false,
    // Previously left at library defaults (max: 10, no idle/connection timeouts). Under
    // load-test-level concurrency the default pool starves fast; these give the pool
    // room to grow and, just as important, bound how long a request waits for a client
    // and how long an idle one lingers instead of freeing its DB-side connection slot.
    max: Number(process.env.DB_POOL_MAX) || 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
});

pool.on('connect', () => {
    console.log('🔗 Connected to the PostgreSQL database.');
});

// Auto-run schema migrations
//
// This whole block is sent as one multi-statement query, which node-postgres/Postgres
// runs as a single implicit transaction: if any statement errors, every statement in
// it is rolled back, including ones before it that would otherwise have succeeded.
// The two UPDATEs against rental_items/rental_bookings used to run BEFORE those
// tables' CREATE TABLE IF NOT EXISTS below -- on a genuinely fresh database (no prior
// deploy), that UPDATE hit a table that didn't exist yet and failed with "relation
// does not exist", aborting the entire block silently (the .catch below only logs).
// That meant rental_items/rental_bookings, and now the indexes, were never created on
// a first-ever run. Table creation must come first.
pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_code VARCHAR(50);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT FALSE;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS district VARCHAR(255);
    -- Clear any Baileys WhatsApp LIDs (15-digit internal IDs) stored as phone numbers
    UPDATE users SET phone = NULL WHERE phone IS NOT NULL AND phone ~ '^[0-9]{14,}$';

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

    UPDATE rental_items SET qty = 2 WHERE qty <= 0 OR qty IS NULL;

    -- Postgres does not auto-index foreign key columns (only PKs and UNIQUE
    -- constraints get one). Every one of these is filtered on directly in routes/*.js
    -- (e.g. "WHERE organizer_id = $1", "WHERE event_id = $1") and had no index at all,
    -- forcing a sequential scan that gets linearly worse as each table grows.
    CREATE INDEX IF NOT EXISTS idx_events_organizer_id ON events(organizer_id);
    CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
    CREATE INDEX IF NOT EXISTS idx_events_district ON events(district);
    CREATE INDEX IF NOT EXISTS idx_bids_event_id ON bids(event_id);
    CREATE INDEX IF NOT EXISTS idx_bids_vendor_id ON bids(vendor_id);
    CREATE INDEX IF NOT EXISTS idx_bids_status ON bids(status);
    CREATE INDEX IF NOT EXISTS idx_rental_items_vendor_id ON rental_items(vendor_id);
    CREATE INDEX IF NOT EXISTS idx_rental_items_category ON rental_items(category);
    CREATE INDEX IF NOT EXISTS idx_rental_bookings_item_id ON rental_bookings(item_id);
    CREATE INDEX IF NOT EXISTS idx_rental_bookings_renter_id ON rental_bookings(renter_id);
    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token_hash ON refresh_tokens(token_hash);
`).then(() => {
    console.log('✅ User, Event, and Rental schemas verified.');
}).catch(err => console.error('⚠️ DB Migration notice:', err.message));

pool.on('error', (err) => {
    console.error('❌ Unexpected error on idle client', err);
    process.exit(-1);
});

module.exports = pool;