import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import {
  addCalendarEvent,
  addWatchlistItem,
  createArticle,
  getArticleBySlug,
  getNewsSummary,
  getPriceHistory,
  getTicker,
  listArticles,
  listCalendarEvents,
  listNews,
  listPortfolio,
  listTickers,
  listWatchlist,
  markNewsItemRead,
  removeCalendarEvent,
  removePortfolioHolding,
  removeWatchlistItem,
  searchArticles,
  setPortfolioManualPrice,
  setWatchlistAccount,
  setWatchlistBuyBelow,
  updatePortfolioHolding,
  upsertPortfolioHolding,
} from '../db/queries.js';
import { refreshStaleNews } from '../services/newsRefresh.js';
import { generateNewsSummary } from '../services/newsSummary.js';
import { refreshStalePortfolioPrices, refreshStaleWatchlistPrices } from '../services/priceRefresh.js';
import { requireApiKey } from './auth.js';

const convictionSchema = z.enum(['high', 'medium', 'low']);
const eventTypeSchema = z.enum(['earnings', 'dividend', 'macro', 'catalyst', 'other']);
// config.accounts is validated non-empty at startup (see config.ts), so this cast is safe.
const accountSchema = z.enum(config.accounts as [string, ...string[]]);
const buyBelowSchema = z.number().positive();

const createWatchlistItemSchema = z.object({
  symbol: z.string().min(1),
  name: z.string().min(1).optional(),
  exchange: z.string().optional(),
  conviction: convictionSchema.optional(),
  notes: z.string().optional(),
  account: accountSchema.optional(),
  buyBelow: buyBelowSchema.optional(),
});

const setAccountSchema = z.object({
  account: accountSchema.nullable(),
});

const setBuyBelowSchema = z.object({
  buyBelow: buyBelowSchema.nullable(),
});

const quantitySchema = z.number().positive();
const averageCostSchema = z.number().positive();
const manualPriceSchema = z.number().positive();

const setManualPriceSchema = z.object({
  price: manualPriceSchema.nullable(),
});

const createPortfolioHoldingSchema = z.object({
  symbol: z.string().min(1),
  name: z.string().min(1).optional(),
  exchange: z.string().optional(),
  account: accountSchema,
  quantity: quantitySchema,
  averageCost: averageCostSchema,
});

const updatePortfolioHoldingSchema = z
  .object({
    quantity: quantitySchema.optional(),
    averageCost: averageCostSchema.optional(),
  })
  .refine((v) => v.quantity !== undefined || v.averageCost !== undefined, {
    message: 'Provide quantity and/or averageCost',
  });

const createCalendarEventSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  title: z.string().min(1),
  description: z.string().optional(),
  eventType: eventTypeSchema.optional(),
  ticker: z.string().optional(),
});

const createArticleSchema = z.object({
  title: z.string().min(1),
  slug: z.string().optional(),
  summary: z.string().optional(),
  body: z.string().min(1),
  conviction: convictionSchema.optional(),
  publishedAt: z.string().optional(),
  tickers: z
    .array(
      z.object({
        symbol: z.string().min(1),
        name: z.string().optional(),
        exchange: z.string().optional(),
        context: z.string().optional(),
        addToWatchlist: z.boolean().optional(),
        account: accountSchema.optional(),
        buyBelow: buyBelowSchema.optional(),
      })
    )
    .optional(),
  calendarEvents: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
        title: z.string().min(1),
        description: z.string().optional(),
        eventType: eventTypeSchema.optional(),
        ticker: z.string().optional(),
      })
    )
    .optional(),
});

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({ status: 'ok' }));

  app.addHook('preHandler', async (req, reply) => {
    if (req.url === '/api/health') return;
    await requireApiKey(req, reply);
  });

  app.get('/api/tickers', async () => listTickers());

  // Read-only - this endpoint never fetches from the price provider itself,
  // it only serves whatever's already been backfilled (see
  // src/cli/backfillHistory.ts / service/README.md). Returns everything
  // stored (up to however far back the CLI was told to go, normally a
  // year), ascending by date; the frontend slices this into its 1M/3M/6M
  // chart views and computes moving averages over the full series before
  // slicing, so a short-range view still has correct MA values from its
  // first visible day.
  app.get('/api/tickers/:symbol/history', async (req) => {
    const { symbol } = req.params as { symbol: string };
    return getPriceHistory(symbol);
  });

  // Lets the frontend build its account dropdowns/filters from the same
  // ACCOUNTS env var the API validates against, rather than keeping its own
  // hard-coded copy that could drift out of sync.
  app.get('/api/accounts', async () => config.accounts);

  app.get('/api/watchlist', async (req) => {
    const status = z.enum(['active', 'removed', 'all']).default('active').parse((req.query as { status?: string }).status);
    await refreshStaleWatchlistPrices();
    return listWatchlist(status);
  });

  app.post('/api/watchlist', async (req, reply) => {
    const body = createWatchlistItemSchema.parse(req.body);
    const item = await addWatchlistItem(body);
    reply.code(201);
    return item;
  });

  app.patch('/api/watchlist/:symbol/account', async (req, reply) => {
    const { symbol } = req.params as { symbol: string };
    const { account } = setAccountSchema.parse(req.body);
    const item = await setWatchlistAccount(symbol, account);
    if (!item) {
      reply.code(404);
      return { error: `No watch-list item for ${symbol}` };
    }
    return item;
  });

  app.patch('/api/watchlist/:symbol/buy-below', async (req, reply) => {
    const { symbol } = req.params as { symbol: string };
    const { buyBelow } = setBuyBelowSchema.parse(req.body);
    const item = await setWatchlistBuyBelow(symbol, buyBelow);
    if (!item) {
      reply.code(404);
      return { error: `No watch-list item for ${symbol}` };
    }
    return item;
  });

  app.delete('/api/watchlist/:symbol', async (req, reply) => {
    const { symbol } = req.params as { symbol: string };
    const item = await removeWatchlistItem(symbol);
    if (!item) {
      reply.code(404);
      return { error: `No watch-list item for ${symbol}` };
    }
    return item;
  });

  app.get('/api/portfolio', async (req) => {
    const query = req.query as { account?: string; status?: string };
    const status = z.enum(['active', 'removed', 'all']).default('active').parse(query.status);
    await refreshStalePortfolioPrices();
    return listPortfolio({ account: query.account, status });
  });

  // Upsert-create: adding a holding for a (symbol, account) pair that
  // already exists overwrites its quantity/average cost rather than
  // erroring, mirroring add_watchlist_item's idiom.
  app.post('/api/portfolio', async (req, reply) => {
    const body = createPortfolioHoldingSchema.parse(req.body);
    const holding = await upsertPortfolioHolding(body);
    reply.code(201);
    return holding;
  });

  // No "change account" endpoint, unlike the watch-list's set-account route -
  // account is part of a holding's identity here (its uniqueness key), so
  // moving a position to a different account is modeled as remove-then-add
  // (an explicit transfer), not an in-place relabel.
  app.patch('/api/portfolio/:symbol/:account', async (req, reply) => {
    const { symbol, account } = req.params as { symbol: string; account: string };
    const body = updatePortfolioHoldingSchema.parse(req.body);
    const holding = await updatePortfolioHolding(symbol, account, body);
    if (!holding) {
      reply.code(404);
      return { error: `No portfolio holding for ${symbol} in "${account}"` };
    }
    return holding;
  });

  app.delete('/api/portfolio/:symbol/:account', async (req, reply) => {
    const { symbol, account } = req.params as { symbol: string; account: string };
    const holding = await removePortfolioHolding(symbol, account);
    if (!holding) {
      reply.code(404);
      return { error: `No portfolio holding for ${symbol} in "${account}"` };
    }
    return holding;
  });

  // Overrides the automatic (Yahoo Finance) price with a value supplied by
  // hand, for a ticker the automatic provider has no reliable quote for -
  // see 009_add_portfolio_manual_price.sql. `price: null` clears it back to
  // automatic, same nullable-to-clear idiom as the watch-list's account/
  // buy-below routes above.
  app.patch('/api/portfolio/:symbol/:account/manual-price', async (req, reply) => {
    const { symbol, account } = req.params as { symbol: string; account: string };
    const { price } = setManualPriceSchema.parse(req.body);
    const holding = await setPortfolioManualPrice(symbol, account, price);
    if (!holding) {
      reply.code(404);
      return { error: `No portfolio holding for ${symbol} in "${account}"` };
    }
    return holding;
  });

  app.get('/api/calendar', async (req) => {
    const query = req.query as { from?: string; to?: string; ticker?: string; status?: string };
    const status = z.enum(['active', 'removed', 'all']).default('active').parse(query.status);
    return listCalendarEvents({ from: query.from, to: query.to, tickerSymbol: query.ticker, status });
  });

  app.post('/api/calendar', async (req, reply) => {
    const body = createCalendarEventSchema.parse(req.body);
    const event = await addCalendarEvent(body);
    reply.code(201);
    return event;
  });

  // Bulk removal by ticker (e.g. clearing out seeded/placeholder dates for a
  // ticker you no longer follow) - the query-param form matches the GET
  // route's own filtering idiom above, rather than a request body on a
  // DELETE. `ticker` is required here; DELETE /api/calendar/:id (below)
  // covers the single-event case. Soft delete, like every other removal in
  // this API - returns whatever was actually removed, `[]` (200, not an
  // error) if nothing matched.
  app.delete('/api/calendar', async (req, reply) => {
    const { ticker } = req.query as { ticker?: string };
    if (!ticker) {
      reply.code(400);
      return { error: 'ticker query parameter is required' };
    }
    return removeCalendarEvent({ ticker });
  });

  app.delete('/api/calendar/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const removed = await removeCalendarEvent({ id });
    if (removed.length === 0) {
      reply.code(404);
      return { error: `No active calendar event with id ${id}` };
    }
    return removed[0];
  });

  app.get('/api/articles', async (req) => {
    const query = req.query as { ticker?: string; q?: string; limit?: string };
    if (query.q) return searchArticles(query.q, query.limit ? Number(query.limit) : undefined);
    return listArticles({ tickerSymbol: query.ticker, limit: query.limit ? Number(query.limit) : undefined });
  });

  app.get('/api/articles/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const article = await getArticleBySlug(slug);
    if (!article) {
      reply.code(404);
      return { error: `No article with slug "${slug}"` };
    }
    return article;
  });

  app.post('/api/articles', async (req, reply) => {
    const body = createArticleSchema.parse(req.body);
    const article = await createArticle({ ...body, source: 'manual' });
    reply.code(201);
    return article;
  });

  app.get('/api/news', async (req) => {
    const query = req.query as { ticker?: string; limit?: string };
    await refreshStaleNews();
    return listNews({ tickerSymbol: query.ticker, limit: query.limit ? Number(query.limit) : undefined });
  });

  app.patch('/api/news/:id/read', async (req, reply) => {
    const { id } = req.params as { id: string };
    const item = await markNewsItemRead(id);
    if (!item) {
      reply.code(404);
      return { error: `No news item with id "${id}"` };
    }
    return item;
  });

  // Read-only - serves whatever's already been generated, never triggers a
  // generation itself. `null` (200, not 404) when nothing's been generated
  // yet for a ticker that does exist - that's a normal state the frontend
  // renders as "no summary yet", not an error. A genuinely unknown ticker
  // still 404s.
  app.get('/api/tickers/:symbol/news-summary', async (req, reply) => {
    const { symbol } = req.params as { symbol: string };
    const ticker = await getTicker(symbol);
    if (!ticker) {
      reply.code(404);
      return { error: `No ticker "${symbol}"` };
    }
    return getNewsSummary(symbol);
  });

  // The "Generate News Summary" button - a real LLM call (see
  // src/services/newsSummary.ts / src/providers/summaries.ts), so this can
  // take a few seconds and, unlike every other route here, can fail for
  // reasons outside our control (the provider's API being down, rate
  // limits, a misconfigured/missing API key). Surfaced as 502 with the
  // provider's own error message rather than a generic 500, so the button's
  // error state can show something actionable.
  app.post('/api/tickers/:symbol/news-summary', async (req, reply) => {
    const { symbol } = req.params as { symbol: string };
    const ticker = await getTicker(symbol);
    if (!ticker) {
      reply.code(404);
      return { error: `No ticker "${symbol}"` };
    }
    try {
      return await generateNewsSummary(ticker);
    } catch (err) {
      reply.code(502);
      return { error: err instanceof Error ? err.message : 'Failed to generate news summary' };
    }
  });
}
