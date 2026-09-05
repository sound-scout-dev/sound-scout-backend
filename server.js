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
const { globalLimiter } = require('./middleware/rateLimit');

const app = express();
const port = process.env.PORT || 5000;

// Comma-separated list of exact origins allowed to make credentialed requests, e.g.
// "https://soundscout.vercel.app,https://app.soundscout.lk". Previously CORS reflected
// *any* request origin back with credentials:true -- functionally no restriction at
// all, since a credentialed request from any attacker-controlled site would pass the
// browser's same-origin check. Without this var set, requests are still accepted (so
// an unconfigured deploy doesn't just break) but a warning is logged.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

if (ALLOWED_ORIGINS.length === 0) {
    console.warn('⚠️  ALLOWED_ORIGINS is not set — CORS is reflecting all origins. Set ALLOWED_ORIGINS to your frontend URL(s) to lock this down.');
}

function isOriginAllowed(origin) {
    if (!origin) return true; // same-origin / non-browser requests carry no Origin header
    if (ALLOWED_ORIGINS.length === 0) return true; // unconfigured: preserve old behavior, but warned above
    return ALLOWED_ORIGINS.includes(origin);
}

// Create HTTP Server and Socket.io instance
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: (origin, callback) => {
            if (isOriginAllowed(origin)) return callback(null, origin || true);
            callback(new Error('Not allowed by CORS'));
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
        if (isOriginAllowed(origin)) return callback(null, origin || true);
        callback(new Error('Not allowed by CORS'));
    },
    credentials: true
}));
app.use(globalLimiter);
app.use(express.json({ limit: '10mb' })); // Parses incoming JSON requests up to 10MB
app.use(express.urlencoded({ limit: '10mb', extended: true }));
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

// Previously `multer({ storage: memoryStorage() })` had no fileFilter or limits, so
// these proxy endpoints accepted a file of any type or size under the 'audio'/'image'
// field name -- no MIME check, no size cap, nothing stopping an .exe or a
// multi-gigabyte upload from being buffered into memory and forwarded to the AI
// service. Each endpoint below gets its own instance scoped to the type it actually
// handles.
function uploadFor(allowedMimePrefix, maxSizeMb) {
    return multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: maxSizeMb * 1024 * 1024 },
        fileFilter: (req, file, cb) => {
            if (!file.mimetype || !file.mimetype.startsWith(allowedMimePrefix)) {
                return cb(new Error(`Only ${allowedMimePrefix}* files are allowed.`));
            }
            cb(null, true);
        }
    });
}

const uploadAudio = uploadFor('audio/', 15);
const uploadImage = uploadFor('image/', 8);

// Multer surfaces fileFilter rejections and size-limit overruns as errors passed to
// next(), which would otherwise fall through to Express's default HTML error page.
function handleUploadErrors(err, req, res, next) {
    if (err instanceof multer.MulterError || err) {
        return res.status(400).json({ error: err.message || 'Upload rejected.' });
    }
    next();
}
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
app.post(['/api/ai-voice', '/ai-voice'], uploadAudio.single('audio'), handleUploadErrors, async (req, res) => {
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

app.post(['/api/ai-image', '/ai-image'], uploadImage.single('image'), handleUploadErrors, async (req, res) => {
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