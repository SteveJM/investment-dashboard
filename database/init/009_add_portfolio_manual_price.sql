-- Manual price override for a portfolio holding whose automatic price
-- provider has no reliable live quote. Concrete case that prompted this:
-- GB00B1DSZS09 (Liontrust UK Listed Smaller Companies Fund B Acc, formerly
-- branded River & Mercantile) returns a "successful" Yahoo Finance quote
-- that's frozen at a 2019-06-28 snapshot (~1775p, versus a real current
-- price around 3220p per the broker) - no error, so the automatic refresh
-- (services/priceRefresh.ts) just silently re-cached that badly wrong,
-- 7-year-stale number every time it ran. Yahoo's mutual-fund NAV coverage
-- for less-liquid UK OEICs is known to be unreliable like this, and no
-- alternate ticker symbol fixes it - the underlying data source simply
-- doesn't have current data for some of these funds.
--
-- While manual_price is set, it takes priority over latest_price/* for
-- display (see queries.ts's mapPortfolioHolding) and the holding is
-- excluded from stalePortfolioPriceSymbols entirely, so the automatic
-- refresh never overwrites it. Setting it back to NULL (via
-- setPortfolioManualPrice) hands the holding back to automatic pricing.
--
-- Deliberately no separate currency column - like average_cost, a manual
-- price is always GBP (this dashboard's holdings are all GBP-denominated;
-- see prices.ts's own currency-normalization comment for the automatic
-- side of that same assumption).
--
-- See database/README.md for how/when init scripts run, and for applying
-- this by hand against an already-running deployment.

ALTER TABLE portfolio_holdings
    ADD COLUMN manual_price             NUMERIC(12, 4) CHECK (manual_price IS NULL OR manual_price > 0),
    ADD COLUMN manual_price_updated_at  TIMESTAMPTZ;
