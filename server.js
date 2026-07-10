// server.js
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json()); // Parses incoming JSON requests

// Basic Health Check Route
app.get('/api/health', (req, res) => {
    res.status(200).json({ status: 'SoundScout AI Backend is Live! 🚀' });
});


// Import Routes
const userRoutes = require('./routes/users');
const eventRoutes = require('./routes/events');

// Use Routes
app.use('/api/users', userRoutes);
app.use('/api/events', eventRoutes);

// const eventRoutes = require('./routes/events');
// app.use('/api/events', eventRoutes);

app.listen(port, () => {
    console.log(`📡 Server is running on port: ${port}`);
});