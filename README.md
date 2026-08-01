# 🎵 SoundScout Backend Engine

The centralized API engine, relational database manager, SSE real-time event broadcaster, and multi-agent AI orchestrator. 

## 🛠️ Tech Stack
* **Runtime:** Node.js v20+, Express.js
* **Database:** PostgreSQL (Hosted on Neon)
* **Driver:** `pg` (node-postgres with Connection Pooling)
* **Authentication:** JWT & bcryptjs password hashing

## 📊 Database Schema 
* **`users`**: User identities, roles (organizer/vendor), verified phones, and password hashes.
* **`events`**: Organizer events, budget, location, date, and AI-deconstructed requirements.
* **`bids`**: Vendor proposals, status (pending, accepted, declined), and escrow payment tracking.
* **`rental_items`**: Real-time instant equipment listings, pricing, quantity, and vendor references.
* **`rental_bookings`**: Instant rental transactions and deposit payments.

## ⚙️ Setup & Execution

### Prerequisites
* Node.js v20+
* A running PostgreSQL instance (or Neon connection string)

### Installation
```bash
git clone [https://github.com/sound-scout-dev/sound-scout-backend.git](https://github.com/sound-scout-dev/sound-scout-backend.git)
cd sound-scout-backend
npm install
```

### Environment Variables (`.env`)
Create a `.env` file in the root directory and add:
```env
PORT=5000
DATABASE_URL=postgres://user:pass@host/dbname
JWT_SECRET=your_super_secret_jwt_key
AI_SERVICE_URL=http://localhost:8000
WHATSAPP_WORKER_URL=http://localhost:4000
```

### Run Locally
```bash
npm start
# or for development:
npm run dev
```
