import { config } from '../config.js';
import { listNews, upsertNewsSummary } from '../db/queries.js';
import { getSummaryProvider } from '../providers/summaries.js';
import type { NewsSummary, Ticker } from '../types/domain.js';

const summaryProvider = getSummaryProvider(config.summaryProvider, config.geminiApiKey, config.geminiModel);

/**
 * Generates (and stores, overwriting any previous one) a fresh news summary
 * for `symbol` - called only from the POST /api/tickers/:symbol/news-summary
 * route, i.e. only when the user clicks "Generate News Summary". Never runs
 * opportunistically like the price/news refreshers, since it's a real LLM
 * API call with real latency and cost.
 *
 * Reads whatever's already in `news_items` for this ticker (does not itself
 * trigger a news refresh) and hands it to the configured `SummaryProvider`.
 */
export async function generateNewsSummary(ticker: Ticker): Promise<NewsSummary> {
  const items = await listNews({ tickerSymbol: ticker.symbol });
  const summaryText = await summaryProvider.summarize(
    ticker.symbol,
    ticker.name,
    items.map((item) => ({
      headline: item.headline,
      url: item.url,
      source: item.source,
      summary: item.summary,
      publishedAt: item.publishedAt,
    }))
  );
  return upsertNewsSummary(ticker.symbol, summaryText);
}
