-- Adds a read/unread flag to news items. New rows start unread; the
-- frontend marks one read when its headline link is clicked. See
-- database/README.md for how/when init scripts run, and for applying this
-- by hand against an already-running deployment.

ALTER TABLE news_items
    ADD COLUMN IF NOT EXISTS is_read BOOLEAN NOT NULL DEFAULT FALSE;
