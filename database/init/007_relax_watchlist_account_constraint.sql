-- Watch-list account names are now configurable via the ACCOUNTS env var
-- (comma-separated) instead of a fixed list - see service/src/config.ts.
-- The CHECK constraint from 003_add_watchlist_account.sql hard-coded the
-- original three account names, so it would silently reject any new name
-- added via ACCOUNTS without a matching migration - the opposite of
-- "configurable". Validation now lives entirely in the application layer
-- (REST/MCP request schemas, built from ACCOUNTS at startup), so the
-- constraint is dropped here. See database/README.md for how/when init
-- scripts run, and for applying this by hand against an already-running
-- deployment.

ALTER TABLE watchlist_items DROP CONSTRAINT IF EXISTS watchlist_items_account_check;
