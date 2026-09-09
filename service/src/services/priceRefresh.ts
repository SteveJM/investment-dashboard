import { config } from '../config.js';
import { stalePortfolioPriceSymbols, staleWatchlistPriceSymbols, updatePortfolioQuote, updateWatchlistQuote } from '../db/queries.js';
import { getPriceProvider } from '../providers/prices.js';

// The real provider (yahoo-finance2, an unofficial Yahoo Finance client) is
// delayed/free data, not a live feed, and this project's own brief was
// "delayed or last night's close is fine" - so there's no reason to refresh
// more often than that, and doing so would just add needless load against
// an API with no published rate limit or SLA to lean on. Matches the news
// refresh's cadence (`newsRefresh.ts`) for the same single-user-dashboard
// reasoning.
const PRICE_STALE_MS = 6 * 60 * 60 * 1000; // 6 hours
const priceProvider = getPriceProvider(config.priceProvider);

/**
 * Refreshes the cached quote for any active watch-list ticker that hasn't
 * been fetched in the last few hours. Called opportunistically from the
 * watch-list API/MCP paths, same pattern as `newsRefresh.ts`.
 */
export async function refreshStaleWatchlistPrices(): Promise<void> {
  const stale = await staleWatchlistPriceSymbols(PRICE_STALE_MS);
  if (stale.length === 0) return;

  await Promise.all(
    stale.map(async ({ symbol, exchange }) => {
      try {
        const quote = await priceProvider.getQuote(symbol, exchange);
        await updateWatchlistQuote(symbol, quote);
      } catch (err) {
        // A single provider failure shouldn't break the whole watch-list.
        console.error(`[prices] failed to refresh ${symbol}:`, err);
      }
    })
  );
}

/**
 * Same as `refreshStaleWatchlistPrices`, but for portfolio holdings' cached
 * quotes. A separate function (rather than folding into the one above)
 * because the two are independent by design (see task #12's queries.ts
 * comment) - a symbol can be stale on one and fresh on the other.
 */
export async function refreshStalePortfolioPrices(): Promise<void> {
  const stale = await stalePortfolioPriceSymbols(PRICE_STALE_MS);
  if (stale.length === 0) return;

  await Promise.all(
    stale.map(async ({ symbol, exchange }) => {
      try {
        const quote = await priceProvider.getQuote(symbol, exchange);
        await updatePortfolioQuote(symbol, quote);
      } catch (err) {
        console.error(`[prices] failed to refresh ${symbol}:`, err);
      }
    })
  );
}
