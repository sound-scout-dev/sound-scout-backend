const pool = require('./config/db');

const sql = `
-- 1. Add premium subscription tracking columns to users
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_premium BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ;

-- 2. Add split-payment and items columns to bids
ALTER TABLE bids ADD COLUMN IF NOT EXISTS bid_items JSONB DEFAULT '[]'::jsonb;
ALTER TABLE bids ADD COLUMN IF NOT EXISTS final_payout_amount NUMERIC(12, 2);
ALTER TABLE bids ADD COLUMN IF NOT EXISTS final_payment_status VARCHAR(50) DEFAULT 'unpaid';
ALTER TABLE bids ADD COLUMN IF NOT EXISTS final_transaction_id VARCHAR(100);

-- 3. Create reviews table
CREATE TABLE IF NOT EXISTS reviews (
    review_id SERIAL PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
    vendor_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    organizer_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    rating NUMERIC(2, 1) NOT NULL CHECK (rating >= 1.0 AND rating <= 5.0),
    comment TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(event_id, vendor_id, organizer_id)
);
`;

pool.query(sql, (err, res) => {
    if (err) {
        console.error("Error migrating financial extension columns:", err);
    } else {
        console.log("Financial extension columns migrated successfully!");
    }
    pool.end();
});
