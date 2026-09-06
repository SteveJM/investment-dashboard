-- Adds a "latest price" quote to watch-list items, refreshed opportunistically
-- from the pluggable price provider (service/src/providers/prices.ts) whenever
-- the watch-list is read. Nullable until the first refresh happens. See
-- database/README.md for how/when init scripts run, and for applying this by
-- hand against an already-running deployment.

ALTER TABLE watchlist_items
    ADD COLUMN IF NOT EXISTS latest_price NUMERIC(12, 2),
    ADD COLUMN IF NOT EXISTS latest_price_change_percent NUMERIC(6, 2),
    ADD COLUMN IF NOT EXISTS latest_price_currency TEXT,
    ADD COLUMN IF NOT EXISTS price_updated_at TIMESTAMPTZ;
