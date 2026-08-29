const pool = require('./config/db');
pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(50)', (err, res) => {
    if (err) {
        console.error(err);
    } else {
        console.log("Added phone column successfully!");
    }
    pool.end();
});
