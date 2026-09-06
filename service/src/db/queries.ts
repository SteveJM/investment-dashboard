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

function mapWatchlistQuote(row: WatchlistRow): WatchlistQuote | null {
  if (row.latest_price === null || row.price_updated_at === null) return null;
  return {
    price: Number(row.latest_price),
    changePercent: row.latest_price_change_percent !== null ? Number(row.latest_price_change_percent) : 0,
    currency: row.latest_price_currency ?? 'GBP',
    asOf: row.price_updated_at.toISOString(),
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
    quote: mapWatchlistQuote(row),
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

/** Symbols on the active watch-list whose news hasn't been fetched within `maxAgeMs`. */
export async function staleWatchlistSymbols(maxAgeMs: number): Promise<string[]> {
  const result = await pool.query<{ symbol: string }>(
    `SELECT w.ticker_symbol AS symbol
     FROM watchlist_items w
     WHERE w.status = 'active'
       AND NOT EXISTS (
         SELECT 1 FROM news_items n
         WHERE n.ticker_symbol = w.ticker_symbol
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
