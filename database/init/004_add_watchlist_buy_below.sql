-- Adds a "buy below" target price to watch-list items - a price threshold
-- you set yourself to flag candidate purchases at a glance. Nullable (unset)
-- since existing items won't have one. See database/README.md for how/when
-- init scripts run, and for applying this by hand against an already-running
-- deployment.

ALTER TABLE watchlist_items
    ADD COLUMN IF NOT EXISTS buy_below NUMERIC(12, 2)
        CHECK (buy_below IS NULL OR buy_below > 0);
