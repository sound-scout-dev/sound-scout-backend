const pool = require('./config/db');

const sql = `
ALTER TABLE bids ADD COLUMN IF NOT EXISTS platform_fee NUMERIC(12, 2);
ALTER TABLE bids ADD COLUMN IF NOT EXISTS deposit_amount NUMERIC(12, 2);
ALTER TABLE bids ADD COLUMN IF NOT EXISTS payment_status VARCHAR(50) DEFAULT 'unpaid';
ALTER TABLE bids ADD COLUMN IF NOT EXISTS transaction_id VARCHAR(100);
`;

pool.query(sql, (err, res) => {
    if (err) {
        console.error("Error migrating financial columns:", err);
    } else {
        console.log("Financial columns migrated successfully!");
    }
    pool.end();
});
