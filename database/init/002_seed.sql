-- Minimal seed data so the dashboard has something to show on first boot.
-- Safe to delete this file if you'd rather start from an empty database --
-- everything here is exactly what create_article via MCP would produce.

INSERT INTO tickers (symbol, name, exchange) VALUES
    ('AAPL', 'Apple Inc.', 'NASDAQ'),
    ('MSFT', 'Microsoft Corporation', 'NASDAQ')
ON CONFLICT DO NOTHING;

WITH new_article AS (
    INSERT INTO articles (title, slug, summary, body, conviction, source)
    VALUES (
        'Welcome to the Investment Dashboard',
        'welcome-to-the-investment-dashboard',
        'A sample research note showing how articles, watch-list items, and calendar events link together.',
        E'# Welcome\n\nThis is a sample research article created by the seed data. In normal use, articles like this are written by Claude via the MCP `create_article` tool during your weekly research run.\n\nIt references **AAPL** and **MSFT**, which is why both show up on the watch-list and why their tickers link back to this article.',
        'medium',
        'manual'
    )
    RETURNING id
)
INSERT INTO article_tickers (article_id, ticker_symbol, context)
SELECT id, symbol, 'Mentioned in the welcome article'
FROM new_article, (VALUES ('AAPL'), ('MSFT')) AS t(symbol);

INSERT INTO watchlist_items (ticker_symbol, conviction, notes, source_article_id)
SELECT 'AAPL', 'medium', 'Seeded example watch-list entry.', a.id
FROM articles a WHERE a.slug = 'welcome-to-the-investment-dashboard';

INSERT INTO watchlist_items (ticker_symbol, conviction, notes, source_article_id)
SELECT 'MSFT', 'medium', 'Seeded example watch-list entry.', a.id
FROM articles a WHERE a.slug = 'welcome-to-the-investment-dashboard';

INSERT INTO calendar_events (event_date, title, description, event_type, ticker_symbol, source_article_id)
SELECT CURRENT_DATE + INTERVAL '14 days', 'AAPL Q/E earnings (example)', 'Placeholder earnings date, flagged by the welcome article.', 'earnings', 'AAPL', a.id
FROM articles a WHERE a.slug = 'welcome-to-the-investment-dashboard';
