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
const fetch = require('node-fetch');
const multer = require('multer');
const FormData = require('form-data');
const upload = multer({ storage: multer.memoryStorage() });
const getAiServiceBaseUrl = () => {
    const envUrl = process.env.AI_SERVICE_URL || 'http://localhost:8000';
    try {
        const parsed = new URL(envUrl);
        return parsed.origin;
    } catch (e) {
        return envUrl.replace(/\/api\/generate\/?$/, '').replace(/\/$/, '');
    }
};

// AI Proxy Routes
// multer parses the multipart upload into memory; we rebuild a proper FormData to forward to Flask
app.post(['/api/ai-voice', '/ai-voice'], upload.single('audio'), async (req, res) => {
    try {
        const baseUrl = getAiServiceBaseUrl();
        const targetUrl = `${baseUrl}/api/voice-intake`;
        console.log(`📡 Proxying AI Voice Intake to: ${targetUrl}`);

        if (!req.file) {
            return res.status(400).json({ error: 'No audio file received by proxy' });
        }

        const form = new FormData();
        form.append('audio', req.file.buffer, {
            filename: req.file.originalname || 'voice_intake.webm',
            contentType: req.file.mimetype || 'audio/webm',
        });

        const response = await fetch(targetUrl, {
            method: 'POST',
            headers: form.getHeaders(),
            body: form
        });

        const data = await response.json();
        res.status(response.status).json(data);
    } catch (err) {
        console.error('AI Voice Proxy Error:', err.message);
        res.status(500).json({ error: 'Failed to proxy voice intake request' });
    }
});

app.post(['/api/ai-image', '/ai-image'], upload.single('image'), async (req, res) => {
    try {
        const baseUrl = getAiServiceBaseUrl();
        const targetUrl = `${baseUrl}/api/venue-analysis`;
        console.log(`📡 Proxying AI Venue Analysis to: ${targetUrl}`);

        if (!req.file) {
            return res.status(400).json({ error: 'No image file received by proxy' });
        }

        const form = new FormData();
        form.append('image', req.file.buffer, {
            filename: req.file.originalname || 'venue.jpg',
            contentType: req.file.mimetype || 'image/jpeg',
        });

        const response = await fetch(targetUrl, {
            method: 'POST',
            headers: form.getHeaders(),
            body: form
        });

        const data = await response.json();
        res.status(response.status).json(data);
    } catch (err) {
        console.error('AI Image Proxy Error:', err.message);
        res.status(500).json({ error: 'Failed to proxy image analysis request' });
    }
});

const userRoutes = require('./routes/users');
const eventRoutes = require('./routes/events');
const bidRoutes = require('./routes/bids');
const inventoryRoutes = require('./routes/inventory');
const rentalRoutes = require('./routes/rentals');

// Use Routes
app.use('/api/users', userRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/bids', bidRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/rentals', rentalRoutes);


// Start server on server.listen (supports both HTTP & WebSockets)
server.listen(port, () => {
    console.log(`📡 Server is running on port: ${port}`);
});