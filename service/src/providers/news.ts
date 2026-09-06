/**
 * Pluggable news provider, same pattern as `providers/prices.ts`: an
 * interface plus swappable implementations, selected via `NEWS_PROVIDER`.
 *
 * `YahooFinanceNewsProvider` is the default - real headlines (with real
 * article links) via `yahoo-finance2`'s `search()` endpoint, the same
 * unofficial Yahoo Finance API `providers/prices.ts` already uses for
 * quotes. See the class doc comment below for details and caveats.
 * `MockNewsProvider` remains available (`NEWS_PROVIDER=mock`) for
 * deterministic offline dev/demo data.
 */

import YahooFinance from 'yahoo-finance2';

export interface NewsHeadline {
  headline: string;
  url: string;
  source: string;
  /** Yahoo's search endpoint doesn't return a snippet/summary - only real providers that do should set this. */
  summary?: string;
  publishedAt: string;
}

export interface NewsProvider {
  getNews(symbol: string, companyName: string): Promise<NewsHeadline[]>;
}

const MOCK_TEMPLATES = [
  (name: string) => `${name} shares move on analyst commentary`,
  (name: string) => `What's next for ${name} after this week's trading`,
  (name: string) => `${name} in focus as sector rotation continues`,
];

export class MockNewsProvider implements NewsProvider {
  async getNews(symbol: string, companyName: string): Promise<NewsHeadline[]> {
    const now = Date.now();
    return MOCK_TEMPLATES.map((template, i) => {
      const publishedAt = new Date(now - i * 6 * 60 * 60 * 1000).toISOString();
      return {
        headline: template(companyName || symbol),
        url: `https://example.com/news/${symbol.toLowerCase()}/${now}-${i}`,
        source: 'Mock Wire',
        summary: `Placeholder summary for a ${symbol} news item. Wire in a real NewsProvider (see providers/news.ts) to replace this.`,
        publishedAt,
      };
    });
  }
}

const MAX_HEADLINES_PER_TICKER = 6;

/**
 * Real headlines from Yahoo Finance's `search()` endpoint - given a
 * free-text query (we use the company name, falling back to the bare
 * ticker symbol if no name is on file) it returns a `news` array alongside
 * any matching quotes, aggregating whichever outlets Yahoo Finance itself
 * surfaces for that company (Reuters, AP, Bloomberg, MarketWatch, Motley
 * Fool, Investing.com, Yahoo's own finance desk, and so on - whichever wire
 * actually ran the story, exposed via `publisher`). Each item carries a
 * real article URL (`link`), so headlines click through to the source
 * rather than a placeholder.
 *
 * Same caveats as `YahooFinancePriceProvider`: this is the same
 * unofficial, no-SLA Yahoo Finance API (not a documented/rate-limited
 * public API), so `services/newsRefresh.ts` only refetches each ticker
 * every few hours rather than polling aggressively. It has NOT been
 * independently network-verified end-to-end from within this environment -
 * this sandbox's egress policy blocks arbitrary internet hosts including
 * Yahoo's, the same limitation noted on the price provider. It should work
 * unmodified from the user's own Docker deployment, which has normal
 * internet access; worth a first-run sanity check that headlines/links
 * come back non-empty and that `docker compose logs service` doesn't show
 * repeated `[news] failed to refresh ...` errors.
 *
 * Yahoo's search endpoint doesn't return an article summary/snippet, only
 * a title and link - `NewsHeadline.summary` is left unset here, and the
 * frontend already treats summary as optional.
 */
export class YahooFinanceNewsProvider implements NewsProvider {
  private client = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

  async getNews(symbol: string, companyName: string): Promise<NewsHeadline[]> {
    const query = companyName?.trim() || symbol;
    const result = await this.client.search(query, {
      newsCount: MAX_HEADLINES_PER_TICKER,
      quotesCount: 0,
    });

    return (result.news ?? [])
      .filter((item) => item.title && item.link)
      .slice(0, MAX_HEADLINES_PER_TICKER)
      .map((item) => ({
        headline: item.title,
        url: item.link,
        source: item.publisher || 'Yahoo Finance',
        publishedAt: (item.providerPublishTime ?? new Date()).toISOString(),
      }));
  }
}

export function getNewsProvider(name: string): NewsProvider {
  switch (name) {
    case 'mock':
      return new MockNewsProvider();
    case 'yahoo':
    default:
      return new YahooFinanceNewsProvider();
  }
}
