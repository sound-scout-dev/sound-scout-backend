const jwt = require('jsonwebtoken');
require('dotenv').config();
const token = jwt.sign(
    { user_id: 4, email: 'ishakyaranhiru@gmail.com', role: 'organizer' },
    process.env.ACCESS_TOKEN_SECRET || 'soundscout_access_secret_12345',
    { expiresIn: '15m' }
);
fetch('http://localhost:5000/api/events', {
    headers: { 'Authorization': `Bearer ${token}` }
}).then(r => r.json()).then(data => {
    console.log(data.length);
}).catch(console.error);
