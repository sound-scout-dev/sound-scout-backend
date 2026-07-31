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
    UPDATE events SET district = 'Colombo' WHERE district IS NULL OR district = '';
`).then(() => {
    console.log('✅ User and Event schemas updated with verification & district columns.');
}).catch(err => console.error('⚠️ DB Migration notice:', err.message));

pool.on('error', (err) => {
    console.error('❌ Unexpected error on idle client', err);
    process.exit(-1);
});

module.exports = pool;