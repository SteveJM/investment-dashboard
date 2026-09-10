-- -----------------------------------------------------------------------------
-- calendar_events gains a status column, matching the soft-delete pattern
-- already used by watchlist_items/portfolio_holdings (see 001_schema.sql).
-- Until now calendar_events had no removal path at all - no MCP tool/REST
-- route, no status column - so a stray or seeded event (e.g. the seed data's
-- placeholder "AAPL Q/E earnings (example)" row) could only ever be cleared
-- by a direct database edit. remove_calendar_event (service/src/db/queries.ts)
-- sets this to 'removed' instead of deleting the row, keeping history intact
-- exactly like the other two soft deletes.
-- -----------------------------------------------------------------------------
ALTER TABLE calendar_events
    ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed'));

CREATE INDEX idx_calendar_events_status ON calendar_events (status);
