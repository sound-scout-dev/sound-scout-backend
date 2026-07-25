const pool = require('./config/db');

async function runMigration() {
    console.log('🔄 Updating events table schema with missing columns...');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        await client.query(`
            ALTER TABLE events 
            ADD COLUMN IF NOT EXISTS name VARCHAR(255),
            ADD COLUMN IF NOT EXISTS environment VARCHAR(50) DEFAULT 'Indoor',
            ADD COLUMN IF NOT EXISTS requirements JSONB,
            ADD COLUMN IF NOT EXISTS description TEXT,
            ADD COLUMN IF NOT EXISTS location VARCHAR(255);
        `);

        await client.query('COMMIT');
        console.log('✅ Migration completed successfully!');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Migration failed:', err.message);
    } finally {
        client.release();
        await pool.end();
    }
}

runMigration();
