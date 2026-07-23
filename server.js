// server.js
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
require('dotenv').config();
const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');
const swaggerDocument = YAML.load('./openapi.yaml');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const port = process.env.PORT || 5000;

// Create HTTP Server and Socket.io instance
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: (origin, callback) => {
            callback(null, origin || true);
        },
        methods: ["GET", "POST", "PUT", "DELETE"],
        credentials: true
    }
});

// Make io accessible to our routers
app.set('io', io);

// Log when a client connects
io.on('connection', (socket) => {
    console.log(`⚡ Socket: Client connected [id: ${socket.id}]`);
    socket.on('disconnect', () => {
        console.log(`🔌 Socket: Client disconnected [id: ${socket.id}]`);
    });
});

// Middleware
app.use(cors({
    origin: (origin, callback) => {
        // Dynamically echo the origin to satisfy credentialed request rules
        callback(null, origin || true);
    },
    credentials: true
}));
app.use(express.json()); // Parses incoming JSON requests
app.use((req, res, next) => {
    console.log(`[${new Date().toLocaleTimeString()}] 🚀 ${req.method} ${req.originalUrl || req.url}`);
    next();
});
app.use(cookieParser()); // Parses Cookie headers and populates req.cookies
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// Basic Health Check Route
app.get('/api/health', (req, res) => {
    res.status(200).json({ status: 'SoundScout AI Backend is Live! 🚀' });
});


// Import Routes
const userRoutes = require('./routes/users');
const eventRoutes = require('./routes/events');
const bidRoutes = require('./routes/bids');
const inventoryRoutes = require('./routes/inventory');
const ratingRoutes = require('./routes/ratings');
const paymentRoutes = require('./routes/payments');

// Use Routes
app.use('/api/users', userRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/bids', bidRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/ratings', ratingRoutes);
app.use('/api/payments', paymentRoutes);

// Start server on server.listen (supports both HTTP & WebSockets)
server.listen(port, () => {
    console.log(`📡 Server is running on port: ${port}`);
});