const pool = require('./config/db');

const sql = `
ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_code VARCHAR(6);
ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_expires_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT FALSE;
`;

pool.query(sql, (err, res) => {
    if (err) {
        console.error("Error migrating OTP columns:", err);
    } else {
        console.log("OTP columns migrated successfully!");
    }
    pool.end();
});
