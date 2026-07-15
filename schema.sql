-- Reconstructed schema for SoundScout AI (no schema file existed in the repo)
-- Derived from queries in routes/users.js, routes/events.js, routes/bids.js, routes/inventory.js

CREATE TABLE IF NOT EXISTS users (
    user_id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    role VARCHAR(50) NOT NULL,
    region VARCHAR(255),
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
    event_id SERIAL PRIMARY KEY,
    organizer_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    event_type VARCHAR(255) NOT NULL,
    crowd_count INTEGER NOT NULL,
    venue_size_sqm INTEGER,
    budget_range VARCHAR(255),
    environment VARCHAR(50) DEFAULT 'Indoor',
    requirements JSONB,
    description TEXT,
    location VARCHAR(255),
    district VARCHAR(255),
    status VARCHAR(50) NOT NULL DEFAULT 'draft',
    ai_infrastructure_plan JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bids (
    bid_id SERIAL PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
    vendor_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    proposed_price NUMERIC NOT NULL,
    notes TEXT,
    bid_categories JSONB,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (event_id, vendor_id)
);
