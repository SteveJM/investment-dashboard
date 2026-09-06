import { config } from '../config.js';
import { listTickers, staleWatchlistSymbols, upsertNewsItems } from '../db/queries.js';
import { getNewsProvider } from '../providers/news.js';

const NEWS_STALE_MS = 6 * 60 * 60 * 1000; // 6 hours
const newsProvider = getNewsProvider(config.newsProvider);

/**
 * Refreshes news for any active watch-list ticker that hasn't been fetched
 * in the last few hours. Called opportunistically from the news API route
 * rather than on a timer - fine for a single-user dashboard, and avoids
 * needing a scheduler inside this container.
 */
export async function refreshStaleWatchlistNews(): Promise<void> {
  const stale = await staleWatchlistSymbols(NEWS_STALE_MS);
  if (stale.length === 0) return;

  const tickers = await listTickers();
  const nameBySymbol = new Map(tickers.map((t) => [t.symbol, t.name]));

  await Promise.all(
    stale.map(async (symbol) => {
      try {
        const headlines = await newsProvider.getNews(symbol, nameBySymbol.get(symbol) ?? symbol);
        await upsertNewsItems(symbol, headlines);
      } catch (err) {
        // A single provider failure shouldn't break the whole news feed.
        console.error(`[news] failed to refresh ${symbol}:`, err);
      }
    })
  );
}
