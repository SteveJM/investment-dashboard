#!/usr/bin/env node
/**
 * Back-fills daily closing prices into `price_history` (see
 * 010_add_price_history.sql) for the ticker-detail page's price chart.
 *
 * This is deliberately a one-off CLI, not something the running service
 * does on its own - unlike the watch-list/portfolio's opportunistic quote
 * refresh (services/priceRefresh.ts), nothing re-runs this automatically.
 * Run it whenever you want a year of history to chart, and re-run it
 * periodically (a cron entry, or just by hand) to keep it current - it's
 * safe to re-run any time: existing dates are overwritten in place, not
 * duplicated (see queries.ts's upsertPriceHistory).
 *
 * Usage (from service/, after `npm run build`):
 *
 *   node dist/cli/backfillHistory.js --symbol=AAL
 *   node dist/cli/backfillHistory.js --symbol=AAL --days=180
 *   node dist/cli/backfillHistory.js --all
 *
 * Or via the npm script (same thing): `npm run backfill-history -- --all`
 *
 * `--all` backfills every ticker already known to the system (anything
 * referenced by the watch-list, portfolio, or an article) - it does not
 * take a symbol that's never been seen before, since there'd be no name/
 * exchange to record for it. Add it via add_watchlist_item,
 * add_portfolio_holding, or create_article first (see MCP.md), then
 * backfill.
 *
 * Uses the same PRICE_PROVIDER/DATABASE_URL env as the service itself -
 * run this inside the `service` container (`docker compose exec service
 * node dist/cli/backfillHistory.js --all`) so it talks to the real Yahoo
 * provider and the real database, not `PRICE_PROVIDER=mock` from a local
 * .env meant for dev.
 */

import { config } from '../config.js';
import { getTicker, listTickers, upsertPriceHistory } from '../db/queries.js';
import { pool } from '../db/pool.js';
import { getPriceProvider } from '../providers/prices.js';

interface Args {
  symbol?: string;
  all: boolean;
  days: number;
}

function parseArgs(argv: string[]): Args {
  let symbol: string | undefined;
  let all = false;
  let days = 365;
  for (const arg of argv) {
    if (arg === '--all') all = true;
    else if (arg.startsWith('--symbol=')) symbol = arg.slice('--symbol='.length).trim();
    else if (arg.startsWith('--days=')) {
      const parsed = Number(arg.slice('--days='.length));
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`--days must be a positive number, got "${arg}"`);
      }
      days = parsed;
    } else {
      throw new Error(`Unrecognized argument: ${arg}`);
    }
  }
  return { symbol, all, days };
}

function usage(): string {
  return [
    'Usage:',
    '  node dist/cli/backfillHistory.js --symbol=<TICKER> [--days=365]',
    '  node dist/cli/backfillHistory.js --all [--days=365]',
  ].join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.symbol && !args.all) {
    console.error('Provide --symbol=<TICKER> or --all.\n');
    console.error(usage());
    process.exitCode = 1;
    return;
  }
  if (args.symbol && args.all) {
    console.error('Provide either --symbol or --all, not both.');
    process.exitCode = 1;
    return;
  }

  const tickers = args.all
    ? await listTickers()
    : [await getTicker(args.symbol!)].filter((t): t is NonNullable<typeof t> => t !== null);

  if (tickers.length === 0) {
    console.error(
      args.all
        ? 'No tickers found - nothing to back-fill yet (add one via add_watchlist_item/add_portfolio_holding/create_article first).'
        : `Ticker "${args.symbol}" isn't known yet - add it via add_watchlist_item, add_portfolio_holding, or create_article first, then back-fill.`
    );
    process.exitCode = 1;
    return;
  }

  const to = new Date();
  const from = new Date(to.getTime() - args.days * 24 * 60 * 60 * 1000);
  console.log(
    `Backfilling ${tickers.length} ticker(s) from ${from.toISOString().slice(0, 10)} to ` +
      `${to.toISOString().slice(0, 10)} via PRICE_PROVIDER=${config.priceProvider} ...`
  );

  const priceProvider = getPriceProvider(config.priceProvider);
  let failures = 0;

  for (const ticker of tickers) {
    try {
      const points = await priceProvider.getHistory(ticker.symbol, ticker.exchange, from, to);
      const written = await upsertPriceHistory(ticker.symbol, points);
      console.log(`  ${ticker.symbol}: fetched ${points.length}, wrote ${written}`);
    } catch (err) {
      failures += 1;
      console.error(`  ${ticker.symbol}: FAILED - ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(failures === 0 ? 'Done.' : `Done, with ${failures} failure(s).`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => {
    // Otherwise the open pg.Pool keeps the event loop alive and the process
    // never exits on its own.
    void pool.end();
  });
