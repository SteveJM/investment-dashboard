export type Conviction = 'high' | 'medium' | 'low';
export type ArticleSource = 'mcp' | 'manual';
export type WatchlistStatus = 'active' | 'removed';
export type CalendarEventType = 'earnings' | 'dividend' | 'macro' | 'catalyst' | 'other';
// Deployment-configurable (see config.ts's `accounts`, from the ACCOUNTS env
// var) rather than a fixed literal union - validated against that list at
// the API/MCP request-schema layer, not by the type system.
export type Account = string;

export interface Ticker {
  symbol: string;
  name: string;
  exchange: string | null;
  createdAt: string;
}

// A daily closing price - see 010_add_price_history.sql. Populated by the
// backfill CLI (src/cli/backfillHistory.ts), read by the ticker page's
// price chart (GET /api/tickers/:symbol/history). Always GBP, like every
// other price column in this schema.
export interface PriceHistoryPoint {
  // ISO 8601 - a plain calendar date under the hood (Postgres DATE), but pg
  // serializes it as a full midnight-UTC timestamp string, same as
  // CalendarEvent's `date` field. New Date(point.date) parses it fine
  // either way; don't assume it's exactly "YYYY-MM-DD".
  date: string;
  close: number;
  currency: string;
}

export interface ArticleTickerRef {
  symbol: string;
  name: string;
  context: string | null;
}

export interface ArticleSummary {
  id: string;
  title: string;
  slug: string;
  summary: string | null;
  conviction: Conviction | null;
  source: ArticleSource;
  publishedAt: string;
  tickers: ArticleTickerRef[];
}

export interface Article extends ArticleSummary {
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface WatchlistQuote {
  price: number;
  changePercent: number;
  currency: string;
  asOf: string;
  // Only ever 'manual' on a portfolio holding (see PortfolioHolding below) -
  // a watch-list quote is always automatic, so this is left undefined there.
  // Marks a quote that came from setPortfolioManualPrice rather than the
  // automatic price provider, so the frontend can show it differently and
  // offer to clear it back to automatic.
  source?: 'auto' | 'manual';
}

export interface WatchlistItem {
  id: string;
  ticker: Ticker;
  conviction: Conviction | null;
  status: WatchlistStatus;
  notes: string | null;
  account: Account | null;
  buyBelow: number | null;
  quote: WatchlistQuote | null;
  sourceArticle: { id: string; title: string; slug: string } | null;
  addedAt: string;
  updatedAt: string;
}

export interface PortfolioHolding {
  id: string;
  ticker: Ticker;
  account: Account;
  quantity: number;
  averageCost: number;
  status: WatchlistStatus;
  // Same shape as a watch-list quote (see `WatchlistQuote` above) - reused
  // as-is rather than duplicated, refreshed the same opportunistic way (see
  // services/priceRefresh.ts).
  quote: WatchlistQuote | null;
  createdAt: string;
  updatedAt: string;
}

export interface CalendarEvent {
  id: string;
  date: string;
  title: string;
  description: string | null;
  eventType: CalendarEventType;
  ticker: { symbol: string; name: string } | null;
  sourceArticle: { id: string; title: string; slug: string } | null;
  createdAt: string;
}

export interface NewsItem {
  id: string;
  ticker: { symbol: string; name: string };
  headline: string;
  url: string | null;
  source: string | null;
  summary: string | null;
  publishedAt: string;
  fetchedAt: string;
  isRead: boolean;
}

// One ticker's on-demand LLM summary of its recent news - see
// 011_add_news_summaries.sql. Only the latest is kept; regenerating
// overwrites `summary` and bumps `createdAt`, which the frontend shows as
// "Generated <timestamp>" underneath the text.
export interface NewsSummary {
  tickerSymbol: string;
  summary: string;
  createdAt: string;
}

export interface CreateArticleTickerInput {
  symbol: string;
  name?: string;
  exchange?: string;
  context?: string;
  addToWatchlist?: boolean;
  account?: Account;
  buyBelow?: number;
}

export interface CreateArticleCalendarEventInput {
  date: string;
  title: string;
  description?: string;
  eventType?: CalendarEventType;
  ticker?: string;
}

export interface CreateArticleInput {
  title: string;
  slug?: string;
  summary?: string;
  body: string;
  conviction?: Conviction;
  source?: ArticleSource;
  publishedAt?: string;
  tickers?: CreateArticleTickerInput[];
  calendarEvents?: CreateArticleCalendarEventInput[];
}
