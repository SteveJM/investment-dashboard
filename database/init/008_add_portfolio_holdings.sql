-- Portfolio holdings: tickers you actually own, tracked independently of the
-- watch-list (a ticker can be on neither, either, or both - watching a
-- ticker and holding it are separate concerns). One row per
-- (ticker, account) pair, since the same ticker can be held as a distinct
-- position in more than one account - unlike watchlist_items, which is one
-- row per ticker regardless of account.
--
-- Account is deliberately unconstrained here (validated at the application
-- layer against the ACCOUNTS env var - see service/src/config.ts), matching
-- watchlist_items post-007 rather than watchlist_items' original pattern.
--
-- latest_price / latest_price_change_percent / latest_price_currency /
-- price_updated_at mirror watchlist_items' quote-caching columns (see
-- 005_add_watchlist_price.sql) - refreshed opportunistically from the same
-- pluggable price provider whenever the portfolio is read.
--
-- See database/README.md for how/when init scripts run, and for applying
-- this by hand against an already-running deployment.

CREATE TABLE portfolio_holdings (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticker_symbol               TEXT NOT NULL REFERENCES tickers(symbol) ON DELETE CASCADE,
    account                     TEXT NOT NULL,
    quantity                    NUMERIC(18, 6) NOT NULL CHECK (quantity > 0),
    average_cost                NUMERIC(12, 2) NOT NULL CHECK (average_cost > 0),
    status                      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
    latest_price                NUMERIC(12, 2),
    latest_price_change_percent NUMERIC(6, 2),
    latest_price_currency       TEXT,
    price_updated_at            TIMESTAMPTZ,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (ticker_symbol, account)
);

CREATE INDEX idx_portfolio_holdings_status ON portfolio_holdings (status);
CREATE INDEX idx_portfolio_holdings_account ON portfolio_holdings (account);
