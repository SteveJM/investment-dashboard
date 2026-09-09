/**
 * Pluggable market-data price provider.
 *
 * Two implementations ship: `MockPriceProvider` (deterministic fake data,
 * useful for offline dev/demo without hitting the network) and
 * `YahooFinancePriceProvider` (real, free, delayed quotes via the unofficial
 * `yahoo-finance2` package - see its class doc comment below for caveats).
 * Both are modeled on GBP-denominated UK-market (LSE) pricing to match this
 * dashboard's watch-list. Swap in a different real provider by implementing
 * `PriceProvider` and adding a `case` to `getPriceProvider()` - nothing else
 * in the codebase needs to change.
 */

import YahooFinance from 'yahoo-finance2';

export interface Quote {
  symbol: string;
  price: number;
  currency: string;
  changePercent: number;
  asOf: string;
}

/** One day's closing price, always normalized to whole-pound GBP - see `HistoricalPoint`'s producers below. */
export interface HistoricalPoint {
  date: string; // YYYY-MM-DD
  close: number; // GBP
}

export interface PriceProvider {
  /** `exchange` is an optional hint (from `tickers.exchange`) a provider can use to pick the right market/symbol suffix. */
  getQuote(symbol: string, exchange?: string | null): Promise<Quote>;
  getQuotes(symbols: string[]): Promise<Quote[]>;
  /**
   * Daily closing prices from `from` to `to` (inclusive), weekdays only -
   * for the price-history backfill CLI (`src/cli/backfillHistory.ts`).
   * Implementations skip non-trading days rather than returning a null/gap
   * entry for them.
   */
  getHistory(symbol: string, exchange: string | null | undefined, from: Date, to: Date): Promise<HistoricalPoint[]>;
}

/**
 * Bit-mixing finalizer (Murmur3's fmix32) so short inputs still spread
 * across the full 32-bit range - without this, the accumulated hash below
 * never grows large enough for a typical 3-5 character ticker to produce
 * anything but a value near zero once divided by 0xffffffff, which made
 * every ticker cluster at the bottom of the price range (all ~£0.50).
 */
function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Deterministic per-symbol pseudo-random number in [0, 1). */
function seededRandom(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = Math.imul(hash, 31) + seed.charCodeAt(i);
    hash |= 0;
  }
  return fmix32(hash) / 0xffffffff;
}

export class MockPriceProvider implements PriceProvider {
  async getQuote(symbol: string): Promise<Quote> {
    const seed = seededRandom(symbol);
    // Modeled on LSE small/mid-cap pricing (per project decision: this
    // dashboard's watch-list is UK-market tickers) - quoted in GBP, not
    // pence/GBX, despite plenty of real UK feeds using pence as the unit.
    const price = 0.5 + seed * 39.5; // £0.50 - £40.00
    const changePercent = (seededRandom(symbol + Date.now().toString().slice(0, 8)) - 0.5) * 6; // +/-3%
    return {
      symbol: symbol.toUpperCase(),
      price: Math.round(price * 100) / 100,
      currency: 'GBP',
      changePercent: Math.round(changePercent * 100) / 100,
      asOf: new Date().toISOString(),
    };
  }

  async getQuotes(symbols: string[]): Promise<Quote[]> {
    return Promise.all(symbols.map((s) => this.getQuote(s)));
  }

  /**
   * Deterministic fake daily-close series, anchored at the same base price
   * as `getQuote` (so the two are at least in the same ballpark) and walked
   * forward day-by-day with a small seeded drift - re-running the backfill
   * CLI against the mock provider reproduces the exact same series, useful
   * for tests/screenshots. Weekends are skipped, same as real trading data.
   */
  async getHistory(symbol: string, _exchange: string | null | undefined, from: Date, to: Date): Promise<HistoricalPoint[]> {
    const points: HistoricalPoint[] = [];
    let price = 0.5 + seededRandom(symbol) * 39.5;
    const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
    const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
    while (cursor.getTime() <= end.getTime()) {
      const day = cursor.getUTCDay();
      if (day !== 0 && day !== 6) {
        const dateStr = cursor.toISOString().slice(0, 10);
        const drift = (seededRandom(`${symbol}:${dateStr}`) - 0.5) * 0.03; // +/-1.5%/day
        price = Math.max(0.05, price * (1 + drift));
        points.push({ date: dateStr, close: Math.round(price * 100) / 100 });
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return points;
  }
}

// Yahoo/yfinance's well-known exchange labels for US-listed tickers. This
// dashboard's watch-list is overwhelmingly UK-market (LSE/AIM), including
// tickers added without an `exchange` value at all, so the default below is
// "assume LSE" and this set is only for the handful of US placeholders
// (e.g. the seeded AAPL/MSFT examples) that should NOT get a ".L" suffix.
const US_EXCHANGE_HINTS = new Set(['NASDAQ', 'NYSE', 'NYSEARCA', 'AMEX', 'NMS', 'NGM', 'NCM', 'PCX', 'BATS']);

function toYahooSymbol(symbol: string, exchange?: string | null): string {
  const upper = symbol.toUpperCase();
  if (exchange && US_EXCHANGE_HINTS.has(exchange.toUpperCase())) return upper;
  return `${upper}.L`;
}

/**
 * Real (free, unofficial) quotes via `yahoo-finance2`, a well-maintained
 * TypeScript port of the same undocumented Yahoo Finance endpoints the
 * Python `yfinance` library scrapes. Chosen over shelling out to Python
 * `yfinance` itself since this service is otherwise pure Node/TypeScript -
 * same underlying data source, no extra runtime in the Docker image.
 *
 * Caveats worth knowing:
 * - **Unofficial/no SLA.** Yahoo doesn't publish this as a real API; it can
 *   change or rate-limit without notice. Fine for a single-user hobby
 *   dashboard on a several-hours refresh cadence (see `priceRefresh.ts`),
 *   not something to build a business on.
 * - **Delayed, not live.** Typically ~15-20 minutes behind for UK equities,
 *   which matches this project's "delayed/previous close is fine" brief.
 * - **Pence vs. pounds.** Yahoo reports LSE-listed instruments in pence
 *   with `currency: "GBp"` (lowercase p - Yahoo's own convention for this,
 *   distinct from "GBP"), while pound-denominated instruments use "GBP".
 *   This is normalized below so the rest of the app only ever sees whole-
 *   pound GBP values.
 * - **Exchange guessing.** Yahoo needs a per-exchange suffix (".L" for
 *   LSE/AIM); see `toYahooSymbol` above for how that's picked.
 * - **Some symbols are just frozen.** Yahoo's mutual-fund NAV coverage for
 *   less-liquid UK OEICs can stop updating without any error - `quote()`
 *   keeps returning the same `regularMarketPrice`/`regularMarketTime`
 *   snapshot from years ago forever. `getQuote` below deliberately stamps
 *   `asOf` with the actual fetch time rather than trusting
 *   `q.regularMarketTime` for exactly this reason: `stalePortfolioPriceSymbols`
 *   /`staleWatchlistPriceSymbols` decide what to refresh next by comparing
 *   `price_updated_at` against "now", so if `asOf` echoed Yahoo's own (long
 *   past) market time, a frozen symbol would look permanently stale and get
 *   silently re-fetched - and re-cache the same wrong number - on every
 *   single request forever, with nothing to show it was even trying. This
 *   still doesn't make the *price* current for a genuinely frozen symbol
 *   (see the portfolio holding's manual-price override,
 *   `setPortfolioManualPrice`, for that case) - it only stops the refresh
 *   loop from being invisible about it.
 *
 * NOT independently network-verified against live Yahoo data during
 * development - the sandbox this was built in blocks outbound requests to
 * arbitrary internet hosts (only package registries are reachable), so
 * only the request-building and TypeScript types were checked, not an
 * actual round-trip. Worth a quick sanity check on first real deploy: a
 * UK ticker like VOD should show roughly £0.60-£1.00, not £60-£100 - if it
 * looks 100x off, the pence/pounds detection above needs adjusting.
 */
export class YahooFinancePriceProvider implements PriceProvider {
  private client = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

  async getQuote(symbol: string, exchange?: string | null): Promise<Quote> {
    const yahooSymbol = toYahooSymbol(symbol, exchange);
    const q = await this.client.quote(yahooSymbol);
    if (q.regularMarketPrice == null) {
      throw new Error(`Yahoo Finance returned no price for ${yahooSymbol}`);
    }

    const isPence = q.currency === 'GBp';
    const price = isPence ? q.regularMarketPrice / 100 : q.regularMarketPrice;
    const currency = isPence ? 'GBP' : (q.currency ?? 'GBP');

    return {
      symbol: symbol.toUpperCase(),
      price: Math.round(price * 100) / 100,
      currency,
      changePercent: q.regularMarketChangePercent != null ? Math.round(q.regularMarketChangePercent * 100) / 100 : 0,
      // The time WE fetched this, not Yahoo's own `regularMarketTime` - see
      // this class's doc comment above ("Some symbols are just frozen").
      asOf: new Date().toISOString(),
    };
  }

  async getQuotes(symbols: string[]): Promise<Quote[]> {
    return Promise.all(symbols.map((s) => this.getQuote(s)));
  }

  /**
   * Daily closes via `chart()` (yahoo-finance2's historical-data module,
   * distinct from `quote()` above) - same pence-vs-pounds normalization,
   * keyed off the *result's* `meta.currency` this time rather than a
   * per-quote field, since `chart()` reports one currency for the whole
   * series rather than per-point.
   */
  async getHistory(symbol: string, exchange: string | null | undefined, from: Date, to: Date): Promise<HistoricalPoint[]> {
    const yahooSymbol = toYahooSymbol(symbol, exchange);
    const result = await this.client.chart(yahooSymbol, { period1: from, period2: to, interval: '1d' });
    const isPence = result.meta.currency === 'GBp';
    const points: HistoricalPoint[] = [];
    for (const q of result.quotes) {
      if (q.close == null) continue; // gap - holiday, halted trading, etc.
      const close = isPence ? q.close / 100 : q.close;
      points.push({ date: q.date.toISOString().slice(0, 10), close: Math.round(close * 100) / 100 });
    }
    return points;
  }
}

export function getPriceProvider(name: string): PriceProvider {
  switch (name) {
    case 'yahoo':
      return new YahooFinancePriceProvider();
    case 'mock':
      return new MockPriceProvider();
    default:
      return new YahooFinancePriceProvider();
  }
}
