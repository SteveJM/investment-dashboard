import type pg from 'pg';
import { pool, withTransaction } from './pool.js';
import type {
  Account,
  Article,
  ArticleSummary,
  ArticleTickerRef,
  CalendarEvent,
  CalendarEventType,
  Conviction,
  CreateArticleInput,
  NewsItem,
  NewsSummary,
  PortfolioHolding,
  PriceHistoryPoint,
  Ticker,
  WatchlistItem,
  WatchlistQuote,
} from '../types/domain.js';

type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

// ---------------------------------------------------------------------------
// Row shapes (snake_case, as returned by pg) + mappers to domain types
// ---------------------------------------------------------------------------

interface TickerRow {
  symbol: string;
  name: string;
  exchange: string | null;
  created_at: Date;
}

function mapTicker(row: TickerRow): Ticker {
  return {
    symbol: row.symbol,
    name: row.name,
    exchange: row.exchange,
    createdAt: row.created_at.toISOString(),
  };
}

interface ArticleRow {
  id: string;
  title: string;
  slug: string;
  summary: string | null;
  body: string;
  conviction: Conviction | null;
  source: 'mcp' | 'manual';
  published_at: Date;
  created_at: Date;
  updated_at: Date;
}

interface ArticleTickerRow {
  symbol: string;
  name: string;
  context: string | null;
}

function mapArticleSummary(row: ArticleRow, tickers: ArticleTickerRef[]): ArticleSummary {
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    summary: row.summary,
    conviction: row.conviction,
    source: row.source,
    publishedAt: row.published_at.toISOString(),
    tickers,
  };
}

function mapArticle(row: ArticleRow, tickers: ArticleTickerRef[]): Article {
  return {
    ...mapArticleSummary(row, tickers),
    body: row.body,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function fetchTickersForArticles(client: Queryable, articleIds: string[]): Promise<Map<string, ArticleTickerRef[]>> {
  const map = new Map<string, ArticleTickerRef[]>();
  if (articleIds.length === 0) return map;
  const result = await client.query<ArticleTickerRow & { article_id: string }>(
    `SELECT at.article_id, at.context, t.symbol, t.name
     FROM article_tickers at
     JOIN tickers t ON t.symbol = at.ticker_symbol
     WHERE at.article_id = ANY($1)
     ORDER BY t.symbol`,
    [articleIds]
  );
  for (const row of result.rows) {
    const list = map.get(row.article_id) ?? [];
    list.push({ symbol: row.symbol, name: row.name, context: row.context });
    map.set(row.article_id, list);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Tickers
// ---------------------------------------------------------------------------

export async function listTickers(): Promise<Ticker[]> {
  const result = await pool.query<TickerRow>('SELECT * FROM tickers ORDER BY symbol');
  return result.rows.map(mapTicker);
}

/** Single-ticker lookup - mainly for the backfill CLI, which needs a ticker's stored `exchange` before it can ask a price provider for history. */
export async function getTicker(symbol: string): Promise<Ticker | null> {
  const result = await pool.query<TickerRow>('SELECT * FROM tickers WHERE symbol = $1', [symbol.toUpperCase()]);
  return result.rows[0] ? mapTicker(result.rows[0]) : null;
}

export async function upsertTicker(
  client: Queryable,
  input: { symbol: string; name?: string; exchange?: string }
): Promise<Ticker> {
  const symbol = input.symbol.trim().toUpperCase();
  const existing = await client.query<TickerRow>('SELECT * FROM tickers WHERE symbol = $1', [symbol]);
  const existingRow = existing.rows[0];

  if (existingRow) {
    if (input.name || input.exchange) {
      const updated = await client.query<TickerRow>(
        'UPDATE tickers SET name = $2, exchange = $3 WHERE symbol = $1 RETURNING *',
        [symbol, input.name ?? existingRow.name, input.exchange ?? existingRow.exchange]
      );
      return mapTicker(updated.rows[0]!);
    }
    return mapTicker(existingRow);
  }

  if (!input.name) {
    throw new Error(`Ticker "${symbol}" doesn't exist yet - provide "name" to create it.`);
  }

  const inserted = await client.query<TickerRow>(
    'INSERT INTO tickers (symbol, name, exchange) VALUES ($1, $2, $3) RETURNING *',
    [symbol, input.name, input.exchange ?? null]
  );
  return mapTicker(inserted.rows[0]!);
}

// ---------------------------------------------------------------------------
// Price history
//
// A time series per ticker (see 010_add_price_history.sql), independent of
// the watch-list/portfolio quote-cache columns (those hold one *current*
// price per row, refreshed opportunistically; this holds a whole daily
// series, populated only by the backfill CLI - nothing refreshes it on a
// read the way the quote-cache columns do).
// ---------------------------------------------------------------------------

interface PriceHistoryRow {
  price_date: string; // pg DATE comes back as 'YYYY-MM-DD'
  close_price: string;
  currency: string;
}

function mapPriceHistoryPoint(row: PriceHistoryRow): PriceHistoryPoint {
  return { date: row.price_date, close: Number(row.close_price), currency: row.currency };
}

/** Full stored history for one ticker, ascending by date - the chart slices this into its 1M/3M/6M views client-side rather than this taking a range param, so a moving average has lookback data before the visible window's start. */
export async function getPriceHistory(symbol: string): Promise<PriceHistoryPoint[]> {
  const result = await pool.query<PriceHistoryRow>(
    'SELECT price_date, close_price, currency FROM price_history WHERE ticker_symbol = $1 ORDER BY price_date ASC',
    [symbol.toUpperCase()]
  );
  return result.rows.map(mapPriceHistoryPoint);
}

/**
 * Batch-upserts a ticker's daily closes (one round trip, not one per point) -
 * what the backfill CLI calls. Existing dates are overwritten (a re-run with
 * a corrected/refreshed value replaces what was there), everything else is
 * left untouched. Returns the number of rows written.
 */
export async function upsertPriceHistory(
  symbol: string,
  points: Array<{ date: string; close: number; currency?: string }>
): Promise<number> {
  if (points.length === 0) return 0;
  const upperSymbol = symbol.toUpperCase();
  const values: string[] = [];
  const params: unknown[] = [];
  for (const p of points) {
    params.push(upperSymbol, p.date, p.close, p.currency ?? 'GBP');
    const base = params.length - 4;
    values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
  }
  const result = await pool.query(
    `INSERT INTO price_history (ticker_symbol, price_date, close_price, currency)
     VALUES ${values.join(', ')}
     ON CONFLICT (ticker_symbol, price_date) DO UPDATE
       SET close_price = EXCLUDED.close_price, currency = EXCLUDED.currency`,
    params
  );
  return result.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Articles
// ---------------------------------------------------------------------------

function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'article';
}

async function uniqueSlug(client: Queryable, base: string): Promise<string> {
  let candidate = base;
  let suffix = 2;
  // Bounded loop - practically never iterates more than once or twice.
  for (let i = 0; i < 1000; i++) {
    const existing = await client.query('SELECT 1 FROM articles WHERE slug = $1', [candidate]);
    if (existing.rowCount === 0) return candidate;
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  throw new Error('Could not generate a unique slug');
}

export async function listArticles(opts: { limit?: number; tickerSymbol?: string } = {}): Promise<ArticleSummary[]> {
  const limit = opts.limit ?? 50;
  const params: unknown[] = [];
  let where = '';
  if (opts.tickerSymbol) {
    params.push(opts.tickerSymbol.toUpperCase());
    where = `WHERE a.id IN (SELECT article_id FROM article_tickers WHERE ticker_symbol = $${params.length})`;
  }
  params.push(limit);
  const result = await pool.query<ArticleRow>(
    `SELECT a.* FROM articles a ${where} ORDER BY a.published_at DESC LIMIT $${params.length}`,
    params
  );
  const tickersByArticle = await fetchTickersForArticles(pool, result.rows.map((r) => r.id));
  return result.rows.map((row) => mapArticleSummary(row, tickersByArticle.get(row.id) ?? []));
}

export async function searchArticles(query: string, limit = 20): Promise<ArticleSummary[]> {
  const result = await pool.query<ArticleRow>(
    `SELECT * FROM articles
     WHERE title ILIKE $1 OR summary ILIKE $1 OR body ILIKE $1
     ORDER BY published_at DESC
     LIMIT $2`,
    [`%${query}%`, limit]
  );
  const tickersByArticle = await fetchTickersForArticles(pool, result.rows.map((r) => r.id));
  return result.rows.map((row) => mapArticleSummary(row, tickersByArticle.get(row.id) ?? []));
}

export async function getArticleBySlug(slug: string): Promise<Article | null> {
  const result = await pool.query<ArticleRow>('SELECT * FROM articles WHERE slug = $1', [slug]);
  const row = result.rows[0];
  if (!row) return null;
  const tickersByArticle = await fetchTickersForArticles(pool, [row.id]);
  return mapArticle(row, tickersByArticle.get(row.id) ?? []);
}

/**
 * Creates a research article together with the tickers it references and any
 * calendar events it flags, in a single transaction. This is what the MCP
 * `create_article` tool calls, and it's also usable from the REST API for
 * manual entry.
 *
 * Referenced tickers are upserted (created if new). Tickers marked
 * `addToWatchlist` are added/updated on the watch-list, pointing back at this
 * article as their source.
 */
export async function createArticle(input: CreateArticleInput): Promise<Article> {
  return withTransaction(async (client) => {
    const baseSlug = input.slug ? slugify(input.slug) : slugify(input.title);
    const slug = await uniqueSlug(client, baseSlug);

    const articleResult = await client.query<ArticleRow>(
      `INSERT INTO articles (title, slug, summary, body, conviction, source, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, now()))
       RETURNING *`,
      [
        input.title,
        slug,
        input.summary ?? null,
        input.body,
        input.conviction ?? null,
        input.source ?? 'mcp',
        input.publishedAt ?? null,
      ]
    );
    const article = articleResult.rows[0]!;

    const tickerRefs: ArticleTickerRef[] = [];
    for (const t of input.tickers ?? []) {
      const ticker = await upsertTicker(client, { symbol: t.symbol, name: t.name, exchange: t.exchange });
      await client.query(
        `INSERT INTO article_tickers (article_id, ticker_symbol, context)
         VALUES ($1, $2, $3)
         ON CONFLICT (article_id, ticker_symbol) DO UPDATE SET context = EXCLUDED.context`,
        [article.id, ticker.symbol, t.context ?? null]
      );
      tickerRefs.push({ symbol: ticker.symbol, name: ticker.name, context: t.context ?? null });

      if (t.addToWatchlist) {
        await client.query(
          `INSERT INTO watchlist_items (ticker_symbol, conviction, account, buy_below, source_article_id, status)
           VALUES ($1, $2, $3, $4, $5, 'active')
           ON CONFLICT (ticker_symbol) DO UPDATE
             SET conviction = EXCLUDED.conviction,
                 account = COALESCE(EXCLUDED.account, watchlist_items.account),
                 buy_below = COALESCE(EXCLUDED.buy_below, watchlist_items.buy_below),
                 source_article_id = EXCLUDED.source_article_id,
                 status = 'active',
                 updated_at = now()`,
          [ticker.symbol, input.conviction ?? null, t.account ?? null, t.buyBelow ?? null, article.id]
        );
      }
    }

    for (const event of input.calendarEvents ?? []) {
      if (event.ticker) {
        // Make sure the ticker exists; if it wasn't in `tickers` above and
        // isn't already known, this will throw a clear error rather than
        // violating the foreign key.
        await upsertTicker(client, { symbol: event.ticker });
      }
      await client.query(
        `INSERT INTO calendar_events (event_date, title, description, event_type, ticker_symbol, source_article_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          event.date,
          event.title,
          event.description ?? null,
          event.eventType ?? 'other',
          event.ticker ? event.ticker.toUpperCase() : null,
          article.id,
        ]
      );
    }

    return mapArticle(article, tickerRefs);
  });
}

// ---------------------------------------------------------------------------
// Watchlist
// ---------------------------------------------------------------------------

interface WatchlistRow {
  id: string;
  conviction: Conviction | null;
  status: 'active' | 'removed';
  notes: string | null;
  account: Account | null;
  buy_below: string | null;
  latest_price: string | null;
  latest_price_change_percent: string | null;
  latest_price_currency: string | null;
  price_updated_at: Date | null;
  added_at: Date;
  updated_at: Date;
  ticker_symbol: string;
  ticker_name: string;
  ticker_exchange: string | null;
  ticker_created_at: Date;
  source_article_id: string | null;
  source_article_title: string | null;
  source_article_slug: string | null;
}

/**
 * Shared by watch-list rows and portfolio-holding rows - both cache a quote
 * via the same four columns (see 005_add_watchlist_price.sql /
 * 008_add_portfolio_holdings.sql), refreshed the same opportunistic way.
 */
function mapQuoteColumns(cols: {
  latest_price: string | null;
  latest_price_change_percent: string | null;
  latest_price_currency: string | null;
  price_updated_at: Date | null;
}): WatchlistQuote | null {
  if (cols.latest_price === null || cols.price_updated_at === null) return null;
  return {
    price: Number(cols.latest_price),
    changePercent: cols.latest_price_change_percent !== null ? Number(cols.latest_price_change_percent) : 0,
    currency: cols.latest_price_currency ?? 'GBP',
    asOf: cols.price_updated_at.toISOString(),
  };
}

function mapWatchlistItem(row: WatchlistRow): WatchlistItem {
  return {
    id: row.id,
    ticker: {
      symbol: row.ticker_symbol,
      name: row.ticker_name,
      exchange: row.ticker_exchange,
      createdAt: row.ticker_created_at.toISOString(),
    },
    conviction: row.conviction,
    status: row.status,
    notes: row.notes,
    account: row.account,
    // pg returns NUMERIC as a string to avoid float precision surprises -
    // this column is a display/comparison value, not used in arithmetic
    // that needs that precision, so a plain number is fine here.
    buyBelow: row.buy_below !== null ? Number(row.buy_below) : null,
    quote: mapQuoteColumns(row),
    sourceArticle: row.source_article_id
      ? { id: row.source_article_id, title: row.source_article_title!, slug: row.source_article_slug! }
      : null,
    addedAt: row.added_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const WATCHLIST_SELECT = `
  SELECT
    w.id, w.conviction, w.status, w.notes, w.account, w.buy_below,
    w.latest_price, w.latest_price_change_percent, w.latest_price_currency, w.price_updated_at,
    w.added_at, w.updated_at,
    t.symbol AS ticker_symbol, t.name AS ticker_name, t.exchange AS ticker_exchange, t.created_at AS ticker_created_at,
    a.id AS source_article_id, a.title AS source_article_title, a.slug AS source_article_slug
  FROM watchlist_items w
  JOIN tickers t ON t.symbol = w.ticker_symbol
  LEFT JOIN articles a ON a.id = w.source_article_id
`;

export async function listWatchlist(status: 'active' | 'removed' | 'all' = 'active'): Promise<WatchlistItem[]> {
  if (status === 'all') {
    const result = await pool.query<WatchlistRow>(`${WATCHLIST_SELECT} ORDER BY w.added_at DESC`);
    return result.rows.map(mapWatchlistItem);
  }
  const result = await pool.query<WatchlistRow>(
    `${WATCHLIST_SELECT} WHERE w.status = $1 ORDER BY w.added_at DESC`,
    [status]
  );
  return result.rows.map(mapWatchlistItem);
}

export async function addWatchlistItem(input: {
  symbol: string;
  name?: string;
  exchange?: string;
  conviction?: Conviction;
  notes?: string;
  account?: Account;
  buyBelow?: number;
  sourceArticleId?: string;
}): Promise<WatchlistItem> {
  return withTransaction(async (client) => {
    const ticker = await upsertTicker(client, { symbol: input.symbol, name: input.name, exchange: input.exchange });
    await client.query(
      `INSERT INTO watchlist_items (ticker_symbol, conviction, notes, account, buy_below, source_article_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'active')
       ON CONFLICT (ticker_symbol) DO UPDATE
         SET conviction = COALESCE(EXCLUDED.conviction, watchlist_items.conviction),
             notes = COALESCE(EXCLUDED.notes, watchlist_items.notes),
             account = COALESCE(EXCLUDED.account, watchlist_items.account),
             buy_below = COALESCE(EXCLUDED.buy_below, watchlist_items.buy_below),
             source_article_id = COALESCE(EXCLUDED.source_article_id, watchlist_items.source_article_id),
             status = 'active',
             updated_at = now()`,
      [
        ticker.symbol,
        input.conviction ?? null,
        input.notes ?? null,
        input.account ?? null,
        input.buyBelow ?? null,
        input.sourceArticleId ?? null,
      ]
    );
    const result = await client.query<WatchlistRow>(`${WATCHLIST_SELECT} WHERE w.ticker_symbol = $1`, [ticker.symbol]);
    return mapWatchlistItem(result.rows[0]!);
  });
}

/**
 * Sets (or clears, with `account: null`) which account a watch-list item
 * relates to. Separate from `addWatchlistItem` because that function's
 * upsert only ever preserves-or-overwrites (via COALESCE) - it can't
 * explicitly null a field back out, which "unassign this item's account"
 * needs to be able to do.
 */
export async function setWatchlistAccount(symbol: string, account: Account | null): Promise<WatchlistItem | null> {
  const result = await pool.query<{ id: string }>(
    `UPDATE watchlist_items SET account = $2, updated_at = now() WHERE ticker_symbol = $1 RETURNING id`,
    [symbol.toUpperCase(), account]
  );
  if (result.rowCount === 0) return null;
  const full = await pool.query<WatchlistRow>(`${WATCHLIST_SELECT} WHERE w.ticker_symbol = $1`, [symbol.toUpperCase()]);
  return full.rows[0] ? mapWatchlistItem(full.rows[0]) : null;
}

/**
 * Sets (or clears, with `buyBelow: null`) a watch-list item's "buy below"
 * target price. Separate from `addWatchlistItem` for the same reason as
 * `setWatchlistAccount` - its upsert can only preserve-or-overwrite, not
 * explicitly null a field back out.
 */
export async function setWatchlistBuyBelow(symbol: string, buyBelow: number | null): Promise<WatchlistItem | null> {
  const result = await pool.query<{ id: string }>(
    `UPDATE watchlist_items SET buy_below = $2, updated_at = now() WHERE ticker_symbol = $1 RETURNING id`,
    [symbol.toUpperCase(), buyBelow]
  );
  if (result.rowCount === 0) return null;
  const full = await pool.query<WatchlistRow>(`${WATCHLIST_SELECT} WHERE w.ticker_symbol = $1`, [symbol.toUpperCase()]);
  return full.rows[0] ? mapWatchlistItem(full.rows[0]) : null;
}

/**
 * Active watch-list tickers whose quote hasn't been refreshed within
 * `maxAgeMs` (or never has). Includes each ticker's `exchange` so a
 * provider that needs it (e.g. to decide whether to query a market-specific
 * symbol suffix) doesn't have to look it up separately.
 */
export async function staleWatchlistPriceSymbols(
  maxAgeMs: number
): Promise<Array<{ symbol: string; exchange: string | null }>> {
  const result = await pool.query<{ symbol: string; exchange: string | null }>(
    `SELECT w.ticker_symbol AS symbol, t.exchange
     FROM watchlist_items w
     JOIN tickers t ON t.symbol = w.ticker_symbol
     WHERE w.status = 'active'
       AND (w.price_updated_at IS NULL OR w.price_updated_at < now() - ($1 || ' milliseconds')::interval)`,
    [maxAgeMs]
  );
  return result.rows;
}

/**
 * Overwrites a watch-list item's cached quote. Deliberately doesn't touch
 * `updated_at` - that column reflects user edits (conviction/notes/account/
 * buy-below), and a background price refresh isn't one of those.
 */
export async function updateWatchlistQuote(symbol: string, quote: WatchlistQuote): Promise<void> {
  await pool.query(
    `UPDATE watchlist_items
     SET latest_price = $2, latest_price_change_percent = $3, latest_price_currency = $4, price_updated_at = $5
     WHERE ticker_symbol = $1`,
    [symbol.toUpperCase(), quote.price, quote.changePercent, quote.currency, quote.asOf]
  );
}

export async function removeWatchlistItem(symbol: string): Promise<WatchlistItem | null> {
  const result = await pool.query<WatchlistRow>(
    `UPDATE watchlist_items SET status = 'removed', updated_at = now()
     WHERE ticker_symbol = $1
     RETURNING id`,
    [symbol.toUpperCase()]
  );
  if (result.rowCount === 0) return null;
  const full = await pool.query<WatchlistRow>(`${WATCHLIST_SELECT} WHERE w.ticker_symbol = $1`, [symbol.toUpperCase()]);
  return full.rows[0] ? mapWatchlistItem(full.rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Portfolio holdings
//
// Deliberately independent of the watch-list (see 008_add_portfolio_holdings.sql)
// - a ticker being held says nothing about whether it's also being watched,
// and vice versa. Addressed by the natural (symbol, account) composite key
// rather than the row's UUID, since that pair is what's unique/meaningful to
// callers (REST paths, MCP tool args) - the id is an implementation detail.
// ---------------------------------------------------------------------------

interface PortfolioRow {
  id: string;
  account: string;
  quantity: string;
  average_cost: string;
  status: 'active' | 'removed';
  latest_price: string | null;
  latest_price_change_percent: string | null;
  latest_price_currency: string | null;
  price_updated_at: Date | null;
  manual_price: string | null;
  manual_price_updated_at: Date | null;
  created_at: Date;
  updated_at: Date;
  ticker_symbol: string;
  ticker_name: string;
  ticker_exchange: string | null;
  ticker_created_at: Date;
}

function mapPortfolioHolding(row: PortfolioRow): PortfolioHolding {
  return {
    id: row.id,
    ticker: {
      symbol: row.ticker_symbol,
      name: row.ticker_name,
      exchange: row.ticker_exchange,
      createdAt: row.ticker_created_at.toISOString(),
    },
    account: row.account,
    // pg returns NUMERIC as a string - these two are used in gain/loss
    // arithmetic client-side, but plain JS numbers are precise enough for
    // display-grade money math at this scale (no accumulation across many
    // rows happens server-side).
    quantity: Number(row.quantity),
    averageCost: Number(row.average_cost),
    status: row.status,
    // A manual override (see setPortfolioManualPrice) always wins over the
    // automatic cached quote, even if both happen to be populated - setting
    // one is the whole point of not trusting the automatic side for this
    // holding. Always GBP, like average_cost (see 009's migration comment).
    quote:
      row.manual_price !== null && row.manual_price_updated_at !== null
        ? {
            price: Number(row.manual_price),
            changePercent: 0,
            currency: 'GBP',
            asOf: row.manual_price_updated_at.toISOString(),
            source: 'manual' as const,
          }
        : mapQuoteColumns(row),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const PORTFOLIO_SELECT = `
  SELECT
    p.id, p.account, p.quantity, p.average_cost, p.status,
    p.latest_price, p.latest_price_change_percent, p.latest_price_currency, p.price_updated_at,
    p.manual_price, p.manual_price_updated_at,
    p.created_at, p.updated_at,
    t.symbol AS ticker_symbol, t.name AS ticker_name, t.exchange AS ticker_exchange, t.created_at AS ticker_created_at
  FROM portfolio_holdings p
  JOIN tickers t ON t.symbol = p.ticker_symbol
`;

export async function listPortfolio(
  opts: { account?: string; status?: 'active' | 'removed' | 'all' } = {}
): Promise<PortfolioHolding[]> {
  const status = opts.status ?? 'active';
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (status !== 'all') {
    params.push(status);
    clauses.push(`p.status = $${params.length}`);
  }
  if (opts.account) {
    params.push(opts.account);
    clauses.push(`p.account = $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await pool.query<PortfolioRow>(`${PORTFOLIO_SELECT} ${where} ORDER BY p.created_at DESC`, params);
  return result.rows.map(mapPortfolioHolding);
}

/**
 * Adds a holding, or - if this (symbol, account) pair already exists -
 * overwrites its quantity/average cost in place and reactivates it if it had
 * been soft-removed. Mirrors `addWatchlistItem`'s upsert idiom, except this
 * always overwrites quantity/averageCost rather than preserving them
 * (COALESCE), since re-adding the same holding means "this is now the
 * position" - not "fill in whatever wasn't set before".
 */
export async function upsertPortfolioHolding(input: {
  symbol: string;
  name?: string;
  exchange?: string;
  account: Account;
  quantity: number;
  averageCost: number;
}): Promise<PortfolioHolding> {
  return withTransaction(async (client) => {
    const ticker = await upsertTicker(client, { symbol: input.symbol, name: input.name, exchange: input.exchange });
    await client.query(
      `INSERT INTO portfolio_holdings (ticker_symbol, account, quantity, average_cost, status)
       VALUES ($1, $2, $3, $4, 'active')
       ON CONFLICT (ticker_symbol, account) DO UPDATE
         SET quantity = EXCLUDED.quantity,
             average_cost = EXCLUDED.average_cost,
             status = 'active',
             updated_at = now()`,
      [ticker.symbol, input.account, input.quantity, input.averageCost]
    );
    const result = await client.query<PortfolioRow>(
      `${PORTFOLIO_SELECT} WHERE p.ticker_symbol = $1 AND p.account = $2`,
      [ticker.symbol, input.account]
    );
    return mapPortfolioHolding(result.rows[0]!);
  });
}

/** Partial update of an existing holding's quantity and/or average cost - for the frontend's inline-editable table cells. */
export async function updatePortfolioHolding(
  symbol: string,
  account: Account,
  updates: { quantity?: number; averageCost?: number }
): Promise<PortfolioHolding | null> {
  const existing = await pool.query<{ quantity: string; average_cost: string }>(
    `SELECT quantity, average_cost FROM portfolio_holdings WHERE ticker_symbol = $1 AND account = $2`,
    [symbol.toUpperCase(), account]
  );
  const row = existing.rows[0];
  if (!row) return null;
  await pool.query(
    `UPDATE portfolio_holdings SET quantity = $3, average_cost = $4, updated_at = now()
     WHERE ticker_symbol = $1 AND account = $2`,
    [
      symbol.toUpperCase(),
      account,
      updates.quantity ?? Number(row.quantity),
      updates.averageCost ?? Number(row.average_cost),
    ]
  );
  const full = await pool.query<PortfolioRow>(
    `${PORTFOLIO_SELECT} WHERE p.ticker_symbol = $1 AND p.account = $2`,
    [symbol.toUpperCase(), account]
  );
  return full.rows[0] ? mapPortfolioHolding(full.rows[0]) : null;
}

export async function removePortfolioHolding(symbol: string, account: Account): Promise<PortfolioHolding | null> {
  const result = await pool.query<{ id: string }>(
    `UPDATE portfolio_holdings SET status = 'removed', updated_at = now()
     WHERE ticker_symbol = $1 AND account = $2
     RETURNING id`,
    [symbol.toUpperCase(), account]
  );
  if (result.rowCount === 0) return null;
  const full = await pool.query<PortfolioRow>(
    `${PORTFOLIO_SELECT} WHERE p.ticker_symbol = $1 AND p.account = $2`,
    [symbol.toUpperCase(), account]
  );
  return full.rows[0] ? mapPortfolioHolding(full.rows[0]) : null;
}

/**
 * Active holdings whose quote hasn't been refreshed within `maxAgeMs` (or
 * never has). Same shape/purpose as `staleWatchlistPriceSymbols`, but a
 * holding's ticker can also be on the watch-list - if so, whichever refresh
 * runs first (this one or the watch-list's) simply primes both rows' cache
 * columns independently, since each has its own price_updated_at.
 */
export async function stalePortfolioPriceSymbols(maxAgeMs: number): Promise<Array<{ symbol: string; exchange: string | null }>> {
  const result = await pool.query<{ symbol: string; exchange: string | null }>(
    `SELECT DISTINCT p.ticker_symbol AS symbol, t.exchange
     FROM portfolio_holdings p
     JOIN tickers t ON t.symbol = p.ticker_symbol
     WHERE p.status = 'active'
       AND p.manual_price IS NULL
       AND (p.price_updated_at IS NULL OR p.price_updated_at < now() - ($1 || ' milliseconds')::interval)`,
    [maxAgeMs]
  );
  return result.rows;
}

/**
 * Overwrites the cached quote for every active holding of `symbol` (there
 * may be more than one - the same ticker held across multiple accounts).
 * Deliberately doesn't touch `updated_at` - see `updateWatchlistQuote`.
 */
export async function updatePortfolioQuote(symbol: string, quote: WatchlistQuote): Promise<void> {
  await pool.query(
    `UPDATE portfolio_holdings
     SET latest_price = $2, latest_price_change_percent = $3, latest_price_currency = $4, price_updated_at = $5
     WHERE ticker_symbol = $1`,
    [symbol.toUpperCase(), quote.price, quote.changePercent, quote.currency, quote.asOf]
  );
}

/**
 * Sets (or, given `null`, clears) a manual price override for one portfolio
 * holding, addressed by ticker + account (same addressing as
 * `updatePortfolioHolding`). For a ticker whose automatic price provider
 * has no reliable live quote - see 009_add_portfolio_manual_price.sql for
 * the concrete case (GB00B1DSZS09, frozen at a 2019 Yahoo snapshot) - this
 * takes over display entirely (`mapPortfolioHolding`) and the holding is
 * skipped by `stalePortfolioPriceSymbols` while it's set, so the automatic
 * refresh never overwrites it. Passing `null` clears the override and hands
 * the holding back to automatic pricing on its next refresh.
 */
export async function setPortfolioManualPrice(symbol: string, account: Account, price: number | null): Promise<PortfolioHolding | null> {
  const result = await pool.query<{ id: string }>(
    // $3 needs an explicit cast: used bare, it appears only inside the CASE
    // condition below in a way Postgres can't infer a type for on its own
    // ("could not determine data type of parameter $3", caught by testing
    // this against a real Postgres, not just by review) - casting pins it
    // down for both usages.
    `UPDATE portfolio_holdings
     SET manual_price = $3::numeric, manual_price_updated_at = CASE WHEN $3::numeric IS NULL THEN NULL ELSE now() END
     WHERE ticker_symbol = $1 AND account = $2
     RETURNING id`,
    [symbol.toUpperCase(), account, price]
  );
  if (result.rowCount === 0) return null;
  const full = await pool.query<PortfolioRow>(`${PORTFOLIO_SELECT} WHERE p.ticker_symbol = $1 AND p.account = $2`, [
    symbol.toUpperCase(),
    account,
  ]);
  return full.rows[0] ? mapPortfolioHolding(full.rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Calendar events
// ---------------------------------------------------------------------------

interface CalendarEventRow {
  id: string;
  event_date: string;
  title: string;
  description: string | null;
  event_type: CalendarEventType;
  created_at: Date;
  ticker_symbol: string | null;
  ticker_name: string | null;
  source_article_id: string | null;
  source_article_title: string | null;
  source_article_slug: string | null;
}

function mapCalendarEvent(row: CalendarEventRow): CalendarEvent {
  return {
    id: row.id,
    date: row.event_date,
    title: row.title,
    description: row.description,
    eventType: row.event_type,
    ticker: row.ticker_symbol ? { symbol: row.ticker_symbol, name: row.ticker_name! } : null,
    sourceArticle: row.source_article_id
      ? { id: row.source_article_id, title: row.source_article_title!, slug: row.source_article_slug! }
      : null,
    createdAt: row.created_at.toISOString(),
  };
}

const CALENDAR_SELECT = `
  SELECT
    c.id, c.event_date, c.title, c.description, c.event_type, c.created_at,
    t.symbol AS ticker_symbol, t.name AS ticker_name,
    a.id AS source_article_id, a.title AS source_article_title, a.slug AS source_article_slug
  FROM calendar_events c
  LEFT JOIN tickers t ON t.symbol = c.ticker_symbol
  LEFT JOIN articles a ON a.id = c.source_article_id
`;

export async function listCalendarEvents(opts: { from?: string; to?: string; tickerSymbol?: string } = {}): Promise<CalendarEvent[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.from) {
    params.push(opts.from);
    clauses.push(`c.event_date >= $${params.length}`);
  }
  if (opts.to) {
    params.push(opts.to);
    clauses.push(`c.event_date <= $${params.length}`);
  }
  if (opts.tickerSymbol) {
    params.push(opts.tickerSymbol.toUpperCase());
    clauses.push(`c.ticker_symbol = $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await pool.query<CalendarEventRow>(`${CALENDAR_SELECT} ${where} ORDER BY c.event_date ASC`, params);
  return result.rows.map(mapCalendarEvent);
}

export async function addCalendarEvent(input: {
  date: string;
  title: string;
  description?: string;
  eventType?: CalendarEventType;
  ticker?: string;
  sourceArticleId?: string;
}): Promise<CalendarEvent> {
  return withTransaction(async (client) => {
    if (input.ticker) {
      await upsertTicker(client, { symbol: input.ticker });
    }
    const result = await client.query<{ id: string }>(
      `INSERT INTO calendar_events (event_date, title, description, event_type, ticker_symbol, source_article_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        input.date,
        input.title,
        input.description ?? null,
        input.eventType ?? 'other',
        input.ticker ? input.ticker.toUpperCase() : null,
        input.sourceArticleId ?? null,
      ]
    );
    const full = await client.query<CalendarEventRow>(`${CALENDAR_SELECT} WHERE c.id = $1`, [result.rows[0]!.id]);
    return mapCalendarEvent(full.rows[0]!);
  });
}

// ---------------------------------------------------------------------------
// News
// ---------------------------------------------------------------------------

interface NewsRow {
  id: string;
  headline: string;
  url: string | null;
  source: string | null;
  summary: string | null;
  published_at: Date;
  fetched_at: Date;
  is_read: boolean;
  ticker_symbol: string;
  ticker_name: string;
}

function mapNewsItem(row: NewsRow): NewsItem {
  return {
    id: row.id,
    ticker: { symbol: row.ticker_symbol, name: row.ticker_name },
    headline: row.headline,
    url: row.url,
    source: row.source,
    summary: row.summary,
    publishedAt: row.published_at.toISOString(),
    fetchedAt: row.fetched_at.toISOString(),
    isRead: row.is_read,
  };
}

const NEWS_SELECT = `
  SELECT n.id, n.headline, n.url, n.source, n.summary, n.published_at, n.fetched_at, n.is_read,
         t.symbol AS ticker_symbol, t.name AS ticker_name
  FROM news_items n
  JOIN tickers t ON t.symbol = n.ticker_symbol
`;

export async function listNews(opts: { tickerSymbol?: string; limit?: number } = {}): Promise<NewsItem[]> {
  const limit = opts.limit ?? 50;
  if (opts.tickerSymbol) {
    // A ticker's own page is the full history for that ticker - no read-status
    // or age filtering, unlike the main news feed below.
    const result = await pool.query<NewsRow>(
      `${NEWS_SELECT} WHERE n.ticker_symbol = $1 ORDER BY n.published_at DESC LIMIT $2`,
      [opts.tickerSymbol.toUpperCase(), limit]
    );
    return result.rows.map(mapNewsItem);
  }
  // The main news feed (no ticker filter) only surfaces what's still worth a
  // glance: anything still unread, or anything recent regardless of read
  // status - so a months-old already-read item doesn't linger at the top of
  // someone's feed just because it's tied to a ticker that hasn't had news
  // since. Old + read drops off; still findable via that ticker's own page.
  const result = await pool.query<NewsRow>(
    `${NEWS_SELECT} WHERE n.is_read = false OR n.published_at > now() - interval '30 days'
     ORDER BY n.published_at DESC LIMIT $1`,
    [limit]
  );
  return result.rows.map(mapNewsItem);
}

/**
 * Symbols worth fetching news for whose news hasn't been fetched within
 * `maxAgeMs` - the union of active watch-list tickers and active portfolio
 * holdings (a ticker you own but never got round to watching should still
 * surface headlines, and vice versa; `UNION` dedupes one that's both).
 */
export async function staleNewsSymbols(maxAgeMs: number): Promise<string[]> {
  const result = await pool.query<{ symbol: string }>(
    `SELECT tracked.symbol
     FROM (
       SELECT ticker_symbol AS symbol FROM watchlist_items WHERE status = 'active'
       UNION
       SELECT ticker_symbol AS symbol FROM portfolio_holdings WHERE status = 'active'
     ) tracked
     WHERE NOT EXISTS (
       SELECT 1 FROM news_items n
       WHERE n.ticker_symbol = tracked.symbol
         AND n.fetched_at > now() - ($1 || ' milliseconds')::interval
     )`,
    [maxAgeMs]
  );
  return result.rows.map((r) => r.symbol);
}

export async function upsertNewsItems(
  symbol: string,
  items: Array<{ headline: string; url?: string; source?: string; summary?: string; publishedAt: string }>
): Promise<void> {
  if (items.length === 0) return;
  await withTransaction(async (client) => {
    for (const item of items) {
      await client.query(
        `INSERT INTO news_items (ticker_symbol, headline, url, source, summary, published_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (ticker_symbol, url) DO UPDATE
           SET headline = EXCLUDED.headline, summary = EXCLUDED.summary, fetched_at = now()`,
        [symbol.toUpperCase(), item.headline, item.url ?? null, item.source ?? null, item.summary ?? null, item.publishedAt]
      );
    }
  });
}

/** Marks a news item read (e.g. once its headline link has been clicked). Idempotent - re-marking an already-read item is a no-op. */
export async function markNewsItemRead(id: string): Promise<NewsItem | null> {
  await pool.query(`UPDATE news_items SET is_read = true WHERE id = $1`, [id]);
  const result = await pool.query<NewsRow>(`${NEWS_SELECT} WHERE n.id = $1`, [id]);
  return result.rows[0] ? mapNewsItem(result.rows[0]) : null;
}

// ---------------------------------------------------------------------------
// News summaries
// ---------------------------------------------------------------------------

interface NewsSummaryRow {
  ticker_symbol: string;
  summary: string;
  created_at: Date;
}

function mapNewsSummary(row: NewsSummaryRow): NewsSummary {
  return {
    tickerSymbol: row.ticker_symbol,
    summary: row.summary,
    createdAt: row.created_at.toISOString(),
  };
}

/** The ticker's current stored summary, if one's been generated - `null` if it never has (a normal, non-error state; see the "Generate News Summary" button). */
export async function getNewsSummary(symbol: string): Promise<NewsSummary | null> {
  const result = await pool.query<NewsSummaryRow>(
    'SELECT ticker_symbol, summary, created_at FROM news_summaries WHERE ticker_symbol = $1',
    [symbol.toUpperCase()]
  );
  return result.rows[0] ? mapNewsSummary(result.rows[0]) : null;
}

/** Upsert-overwrite: regenerating a summary replaces the previous one and bumps `created_at` - only the latest is ever kept, there's no history table for these. */
export async function upsertNewsSummary(symbol: string, summary: string): Promise<NewsSummary> {
  const result = await pool.query<NewsSummaryRow>(
    `INSERT INTO news_summaries (ticker_symbol, summary)
     VALUES ($1, $2)
     ON CONFLICT (ticker_symbol) DO UPDATE
       SET summary = EXCLUDED.summary, created_at = now()
     RETURNING ticker_symbol, summary, created_at`,
    [symbol.toUpperCase(), summary]
  );
  return mapNewsSummary(result.rows[0]!);
}
