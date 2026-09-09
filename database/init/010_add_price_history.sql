-- Daily closing prices per ticker, for the ticker-detail page's price chart
-- (1/3/6-month views with moving-average overlays) and its underlying
-- backfill CLI (`npm run backfill-history` in service/ - see
-- service/README.md). Deliberately its own table rather than reusing
-- watchlist_items/portfolio_holdings' quote-cache columns - those hold one
-- *current* price per row; this holds a whole time series per ticker,
-- shared across every account/watch-list entry for that same ticker.
--
-- One row per (ticker, calendar date) - close_price is whatever the price
-- provider reports for that day, always normalized to whole-pound GBP by
-- the caller (see providers/prices.ts's pence-vs-pounds handling), same
-- convention as every other price column in this schema. Nothing here
-- back-fills or refreshes itself automatically - see the CLI.
--
-- See database/README.md for how/when init scripts run, and for applying
-- this by hand against an already-running deployment.

CREATE TABLE price_history (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticker_symbol TEXT NOT NULL REFERENCES tickers(symbol) ON DELETE CASCADE,
    price_date    DATE NOT NULL,
    close_price   NUMERIC(12, 4) NOT NULL CHECK (close_price > 0),
    currency      TEXT NOT NULL DEFAULT 'GBP',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (ticker_symbol, price_date)
);

-- The chart/backfill access pattern is always "this ticker, ordered by
-- date" - a composite index in that order serves both the equality filter
-- and the sort in one pass.
CREATE INDEX idx_price_history_symbol_date ON price_history (ticker_symbol, price_date);
