-- Row Level Security backstop for SoundScout AI.
--
-- Authorization today lives entirely in application code (routes/*.js WHERE clauses
-- checking organizer_id/vendor_id against the JWT-derived user). That's consistent,
-- but has no database-layer backstop: one missed WHERE clause in a future change is a
-- full IDOR with nothing else standing in the way. This adds real Postgres RLS
-- policies that enforce the same rules the app already relies on, so a bug in the app
-- layer degrades to "denied" instead of "leaked".
--
-- Policies are written to match EXISTING app behavior exactly, including its
-- intentional public/shared visibility (open marketplace listings, competitive bid
-- transparency on events open for bidding, public vendor reviews) -- this is a
-- backstop, not a product change. Run this after config/db.js's auto-migration has
-- created rental_items/rental_bookings (fresh DBs) and after migrate_financial_ext.js
-- has created `reviews` (this repo has no single source of truth for that table).
--
-- FORCE ROW LEVEL SECURITY matters here: without it, RLS is skipped for the table
-- owner, and the app's DB user is very likely also the owner (it's the one running
-- CREATE TABLE IF NOT EXISTS at startup) -- so policies would silently do nothing.
--
-- refresh_tokens is intentionally NOT covered: its lookup is by token_hash before the
-- caller's identity is known (that's the whole point of a refresh token), so a
-- user-scoped policy can't apply to its own bootstrap query. Its security boundary is
-- the token's unguessability (SHA-256 of a signed JWT), not row visibility.

-- ── events ──────────────────────────────────────────────────────────────────
-- SELECT stays open: GET /api/events/:eventId is intentionally reachable by any
-- authenticated user (a vendor viewing an event they might bid on), and GET
-- /api/events/open is a public-to-vendors marketplace listing. Writes are
-- organizer-owned, matching the app's existing `WHERE organizer_id = $N` checks.
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS events_select ON events;
CREATE POLICY events_select ON events FOR SELECT USING (true);

DROP POLICY IF EXISTS events_insert ON events;
CREATE POLICY events_insert ON events FOR INSERT
    WITH CHECK (organizer_id = current_setting('app.current_user_id', true)::int);

DROP POLICY IF EXISTS events_update ON events;
CREATE POLICY events_update ON events FOR UPDATE
    USING (organizer_id = current_setting('app.current_user_id', true)::int)
    WITH CHECK (organizer_id = current_setting('app.current_user_id', true)::int);

-- ── bids ────────────────────────────────────────────────────────────────────
-- SELECT/UPDATE cover three legitimate viewers today: the bidding vendor, the
-- organizer of the event the bid is on, and (per routes/events.js GET /open, which
-- returns other vendors' existing_bids on events still open for bidding) any
-- authenticated vendor browsing that open job -- deliberate competitive transparency,
-- not a leak. INSERT is vendor-owned; only organizers transition bid status.
ALTER TABLE bids ENABLE ROW LEVEL SECURITY;
ALTER TABLE bids FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bids_select ON bids;
CREATE POLICY bids_select ON bids FOR SELECT USING (
    vendor_id = current_setting('app.current_user_id', true)::int
    OR event_id IN (SELECT event_id FROM events WHERE organizer_id = current_setting('app.current_user_id', true)::int)
    OR event_id IN (SELECT event_id FROM events WHERE status = 'bidding_open')
);

DROP POLICY IF EXISTS bids_insert ON bids;
CREATE POLICY bids_insert ON bids FOR INSERT
    WITH CHECK (vendor_id = current_setting('app.current_user_id', true)::int);

DROP POLICY IF EXISTS bids_update ON bids;
CREATE POLICY bids_update ON bids FOR UPDATE
    USING (event_id IN (SELECT event_id FROM events WHERE organizer_id = current_setting('app.current_user_id', true)::int))
    WITH CHECK (event_id IN (SELECT event_id FROM events WHERE organizer_id = current_setting('app.current_user_id', true)::int));

-- ── rental_items ────────────────────────────────────────────────────────────
-- Public catalog: SELECT stays open (GET /api/rentals has no auth at all today).
-- UPDATE also stays open -- POST /api/rentals/:id/book intentionally lets the
-- *renter* (not the listing's vendor) decrement `qty` as part of booking, so an
-- ownership-restricted UPDATE policy would break that flow. INSERT (listing a new
-- item) is vendor-owned.
ALTER TABLE rental_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_items FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rental_items_select ON rental_items;
CREATE POLICY rental_items_select ON rental_items FOR SELECT USING (true);

DROP POLICY IF EXISTS rental_items_insert ON rental_items;
CREATE POLICY rental_items_insert ON rental_items FOR INSERT
    WITH CHECK (vendor_id = current_setting('app.current_user_id', true)::int);

DROP POLICY IF EXISTS rental_items_update ON rental_items;
CREATE POLICY rental_items_update ON rental_items FOR UPDATE USING (true) WITH CHECK (true);

-- ── rental_bookings ─────────────────────────────────────────────────────────
-- Visible to the renter or the vendor of the booked item (matches
-- "WHERE b.renter_id = $1 OR r.vendor_id = $1" in GET /my-bookings exactly).
ALTER TABLE rental_bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_bookings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rental_bookings_select ON rental_bookings;
CREATE POLICY rental_bookings_select ON rental_bookings FOR SELECT USING (
    renter_id = current_setting('app.current_user_id', true)::int
    OR item_id IN (SELECT item_id FROM rental_items WHERE vendor_id = current_setting('app.current_user_id', true)::int)
);

DROP POLICY IF EXISTS rental_bookings_insert ON rental_bookings;
CREATE POLICY rental_bookings_insert ON rental_bookings FOR INSERT
    WITH CHECK (renter_id = current_setting('app.current_user_id', true)::int);

-- ── reviews ─────────────────────────────────────────────────────────────────
-- Public read (GET /api/bids/reviews/vendor/:vendorId shows any vendor's reviews to
-- any authenticated user today). Writes are organizer-owned; the upsert's ON CONFLICT
-- DO UPDATE target (event_id, vendor_id, organizer_id) always matches the same
-- organizer_id being written, so the UPDATE policy's USING clause is satisfied by
-- construction. Guarded with a DO block since this table only exists where
-- migrate_financial_ext.js has already been run.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'reviews') THEN
        EXECUTE 'ALTER TABLE reviews ENABLE ROW LEVEL SECURITY';
        EXECUTE 'ALTER TABLE reviews FORCE ROW LEVEL SECURITY';

        EXECUTE 'DROP POLICY IF EXISTS reviews_select ON reviews';
        EXECUTE 'CREATE POLICY reviews_select ON reviews FOR SELECT USING (true)';

        EXECUTE 'DROP POLICY IF EXISTS reviews_insert ON reviews';
        EXECUTE $p$CREATE POLICY reviews_insert ON reviews FOR INSERT
            WITH CHECK (organizer_id = current_setting('app.current_user_id', true)::int)$p$;

        EXECUTE 'DROP POLICY IF EXISTS reviews_update ON reviews';
        EXECUTE $p$CREATE POLICY reviews_update ON reviews FOR UPDATE
            USING (organizer_id = current_setting('app.current_user_id', true)::int)
            WITH CHECK (organizer_id = current_setting('app.current_user_id', true)::int)$p$;
    END IF;
END $$;
