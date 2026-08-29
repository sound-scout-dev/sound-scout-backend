const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');

const ACCESS_TOKEN_SECRET = 'soundscout_access_secret_12345';
const token = jwt.sign(
    { user_id: 4, email: 'ishakyaranhiru@gmail.com', role: 'organizer' },
    ACCESS_TOKEN_SECRET,
    { expiresIn: '15m' }
);

async function run() {
    try {
        const res = await fetch("http://localhost:5000/api/events", {
            headers: { "Authorization": "Bearer " + token }
        });
        if (!res.ok) {
            console.log("Failed:", res.status, await res.text());
        } else {
            const data = await res.json();
            console.log("Success! Events fetched:", data.length);
        }
    } catch (err) {
        console.error("Fetch error:", err);
    }
}
run();
