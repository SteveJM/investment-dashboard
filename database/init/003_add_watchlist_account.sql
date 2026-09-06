-- Adds an "account" tag to watch-list items - which of your accounts a
-- ticker relates to. Nullable (unassigned) since existing items won't have
-- one set. See database/README.md for how/when init scripts run, and for
-- applying this by hand against an already-running deployment.

ALTER TABLE watchlist_items
    ADD COLUMN IF NOT EXISTS account TEXT
        CHECK (account IN ('ISA', 'Taxable', 'Pension'));

CREATE INDEX IF NOT EXISTS idx_watchlist_account ON watchlist_items (account);
