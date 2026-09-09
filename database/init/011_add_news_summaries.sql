-- -----------------------------------------------------------------------------
-- news_summaries: an on-demand, LLM-generated summary of a ticker's recent
-- news - one row per ticker, overwritten (not appended) each time it's
-- regenerated, so only the latest summary is ever kept. Populated by
-- POST /api/tickers/:symbol/news-summary (the ticker page's "Generate News
-- Summary" button), never automatically - see
-- service/src/providers/summaries.ts and service/README.md.
-- -----------------------------------------------------------------------------
CREATE TABLE news_summaries (
    ticker_symbol TEXT PRIMARY KEY REFERENCES tickers(symbol) ON DELETE CASCADE,
    summary       TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
