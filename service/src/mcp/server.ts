import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from '../config.js';
import {
  addCalendarEvent,
  addWatchlistItem,
  createArticle,
  getArticleBySlug,
  listCalendarEvents,
  listWatchlist,
  removeWatchlistItem,
  searchArticles,
  setWatchlistAccount,
  setWatchlistBuyBelow,
} from '../db/queries.js';
import { refreshStaleWatchlistPrices } from '../services/priceRefresh.js';

const convictionSchema = z.enum(['high', 'medium', 'low']);
const eventTypeSchema = z.enum(['earnings', 'dividend', 'macro', 'catalyst', 'other']);
// config.accounts is validated non-empty at startup (see config.ts), so this cast is safe.
const accountSchema = z.enum(config.accounts as [string, ...string[]]);
const buyBelowSchema = z.number().positive();

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

/**
 * Builds a fresh MCP server instance with all Investment Dashboard tools
 * registered. Called once per incoming connection by mcp/http.ts.
 */
export function createInvestmentDashboardMcpServer(): McpServer {
  const server = new McpServer({
    name: 'investment-dashboard',
    version: '1.0.0',
  });

  server.registerTool(
    'create_article',
    {
      title: 'Create research article',
      description:
        'Publish a research article/briefing to the Investment Dashboard. Use this for the weekly research write-up: ' +
        'reference the tickers it discusses (optionally adding them to the watch-list) and any notable dates it flags ' +
        '(earnings, dividends, catalysts, macro events). Tickers and dates you pass here will link back to this ' +
        'article on the dashboard.',
      inputSchema: {
        title: z.string().min(1).describe('Article title'),
        summary: z.string().optional().describe('One or two sentence summary shown in list views'),
        body: z.string().min(1).describe('Full article body, markdown supported'),
        conviction: convictionSchema.optional().describe('Overall conviction level for this article'),
        tickers: z
          .array(
            z.object({
              symbol: z.string().describe('Ticker symbol, e.g. AAPL'),
              name: z.string().optional().describe('Company name - required the first time a symbol is used'),
              exchange: z.string().optional(),
              context: z.string().optional().describe('Why this ticker is relevant to the article'),
              addToWatchlist: z.boolean().optional().describe('Add/update this ticker on the watch-list, sourced from this article'),
              account: accountSchema.optional().describe('Which account this ticker relates to, if adding it to the watch-list'),
              buyBelow: buyBelowSchema
                .optional()
                .describe('Target price - flag this as a candidate purchase if it trades below this, if adding it to the watch-list'),
            })
          )
          .optional(),
        calendarEvents: z
          .array(
            z.object({
              date: z.string().describe('YYYY-MM-DD'),
              title: z.string(),
              description: z.string().optional(),
              eventType: eventTypeSchema.optional(),
              ticker: z.string().optional().describe('Ticker symbol this date relates to, if any'),
            })
          )
          .optional(),
      },
    },
    async (args) => {
      try {
        const article = await createArticle(args);
        return jsonResult(article);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    'add_watchlist_item',
    {
      title: 'Add/update watch-list item',
      description: 'Add a ticker to the watch-list, or update its conviction/notes/account/buy-below if it is already there.',
      inputSchema: {
        symbol: z.string(),
        name: z.string().optional().describe('Required if this ticker has never been referenced before'),
        exchange: z.string().optional(),
        conviction: convictionSchema.optional(),
        notes: z.string().optional(),
        account: accountSchema.optional().describe('Which account this ticker relates to'),
        buyBelow: buyBelowSchema.optional().describe('Target price - flag this as a candidate purchase if it trades below this'),
      },
    },
    async (args) => {
      try {
        return jsonResult(await addWatchlistItem(args));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    'set_watchlist_account',
    {
      title: 'Set/clear watch-list item account',
      description:
        `Sets which account a watch-list item relates to (${config.accounts.join(' / ')}), or clears it by ` +
        'passing no account. Unlike add_watchlist_item, this can explicitly unset the account.',
      inputSchema: {
        symbol: z.string(),
        account: accountSchema.optional().describe('Omit to clear the account back to unassigned'),
      },
    },
    async ({ symbol, account }) => {
      const item = await setWatchlistAccount(symbol, account ?? null);
      return item ? jsonResult(item) : errorResult(`No watch-list item for ${symbol}`);
    }
  );

  server.registerTool(
    'set_watchlist_buy_below',
    {
      title: 'Set/clear watch-list item buy-below price',
      description:
        'Sets the target "buy below" price for a watch-list item - a price threshold used to flag it as a candidate ' +
        'purchase - or clears it by passing no buyBelow. Unlike add_watchlist_item, this can explicitly unset the value.',
      inputSchema: {
        symbol: z.string(),
        buyBelow: buyBelowSchema.optional().describe('Omit to clear the buy-below price back to unset'),
      },
    },
    async ({ symbol, buyBelow }) => {
      const item = await setWatchlistBuyBelow(symbol, buyBelow ?? null);
      return item ? jsonResult(item) : errorResult(`No watch-list item for ${symbol}`);
    }
  );

  server.registerTool(
    'remove_watchlist_item',
    {
      title: 'Remove watch-list item',
      description: 'Marks a ticker as removed from the watch-list (soft delete - history is kept).',
      inputSchema: { symbol: z.string() },
    },
    async ({ symbol }) => {
      const item = await removeWatchlistItem(symbol);
      return item ? jsonResult(item) : errorResult(`No watch-list item for ${symbol}`);
    }
  );

  server.registerTool(
    'list_watchlist',
    {
      title: 'List watch-list',
      description: 'Lists current watch-list items (default: active only).',
      inputSchema: { status: z.enum(['active', 'removed', 'all']).optional() },
    },
    async ({ status }) => {
      await refreshStaleWatchlistPrices();
      return jsonResult(await listWatchlist(status ?? 'active'));
    }
  );

  server.registerTool(
    'add_calendar_event',
    {
      title: 'Add calendar event',
      description: 'Flags a notable date on the dashboard calendar (earnings, dividend, macro release, catalyst, etc).',
      inputSchema: {
        date: z.string().describe('YYYY-MM-DD'),
        title: z.string(),
        description: z.string().optional(),
        eventType: eventTypeSchema.optional(),
        ticker: z.string().optional(),
      },
    },
    async (args) => {
      try {
        return jsonResult(await addCalendarEvent(args));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    'list_upcoming_events',
    {
      title: 'List upcoming calendar events',
      description: 'Lists calendar events in a date range. Defaults to the next 30 days if no range is given.',
      inputSchema: {
        from: z.string().optional().describe('YYYY-MM-DD, defaults to today'),
        to: z.string().optional().describe('YYYY-MM-DD, defaults to 30 days from today'),
        ticker: z.string().optional(),
      },
    },
    async ({ from, to, ticker }) => {
      const today = new Date();
      const defaultFrom = today.toISOString().slice(0, 10);
      const defaultTo = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      return jsonResult(
        await listCalendarEvents({ from: from ?? defaultFrom, to: to ?? defaultTo, tickerSymbol: ticker })
      );
    }
  );

  server.registerTool(
    'search_articles',
    {
      title: 'Search research articles',
      description: 'Full-text-ish search (title/summary/body) across past research articles.',
      inputSchema: { query: z.string().min(1) },
    },
    async ({ query }) => jsonResult(await searchArticles(query))
  );

  server.registerTool(
    'get_article',
    {
      title: 'Get research article',
      description: 'Fetches a single article by its slug (as returned by create_article/search_articles).',
      inputSchema: { slug: z.string() },
    },
    async ({ slug }) => {
      const article = await getArticleBySlug(slug);
      return article ? jsonResult(article) : errorResult(`No article with slug "${slug}"`);
    }
  );

  return server;
}
