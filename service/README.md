# service

Node.js/TypeScript service tier: a REST API for the frontend and an MCP
server for Claude, both talking to the same Postgres database and sharing
the same query layer (`src/db/queries.ts`) so they can never drift apart.

## Layout

```
src/
  config.ts          env var loading
  db/
    pool.ts           pg Pool + transaction helper
    queries.ts         all reads/writes - shared by REST routes and MCP tools
  providers/
    prices.ts          pluggable price provider - real (yahoo-finance2) + mock implementations
    news.ts             pluggable news provider - real (yahoo-finance2) + mock implementations
    summaries.ts         pluggable news-summary provider - real (Gemini) + mock implementations
  services/
    newsRefresh.ts       refreshes stale watch-list news from the news provider
    newsSummary.ts        generates + stores a ticker's on-demand news summary
  api/
    auth.ts              bearer-token auth middleware
    routes.ts            REST endpoints, mounted under /api
  mcp/
    server.ts            MCP tool definitions
    http.ts               Streamable HTTP transport + session handling
  index.ts               bootstraps both the REST API and the MCP server
```

## Running locally (without Docker)

```bash
cp .env.example .env   # then edit DATABASE_URL etc if needed
npm install
npm run build
npm start
# or, for hot reload:
npm run dev
```

REST API: `http://localhost:4000/api/...` (all routes except `/api/health`
require `Authorization: Bearer <API_KEY>`).

MCP server: `http://localhost:4001/mcp` (Streamable HTTP transport, same
bearer token). To point a Claude session at it - e.g. as a custom MCP
connector for your weekly research scheduled task - use that URL with the
`Authorization: Bearer <API_KEY>` header.

## MCP tools exposed

Full input schemas, return shapes, upsert/soft-delete semantics, and
worked examples for every tool below are in **[`MCP.md`](./MCP.md)** - this
table is just an index.

| Tool                        | Purpose                                                                 |
|------------------------------|--------------------------------------------------------------------------|
| `create_article`             | Publish a research article; optionally references tickers (adding them to the watch-list) and flags calendar dates - all in one transaction |
| `search_articles`            | Search past articles by title/summary/body                              |
| `get_article`                | Fetch a single article by slug                                          |
| `add_watchlist_item`         | Add/update a ticker on the watch-list (upsert preserves omitted fields)  |
| `set_watchlist_account`      | Set/clear which account a watch-list item relates to                    |
| `set_watchlist_buy_below`    | Set/clear a watch-list item's target buy-below price                    |
| `remove_watchlist_item`      | Soft-remove a ticker from the watch-list                                |
| `list_watchlist`             | List current watch-list items (triggers an opportunistic price refresh) |
| `add_portfolio_holding`      | Add/overwrite a portfolio holding for a (ticker, account) pair          |
| `set_portfolio_holding`      | Partially update a holding's quantity and/or average cost               |
| `remove_portfolio_holding`   | Soft-remove a holding from one account                                  |
| `set_portfolio_manual_price` | Set/clear a manual price override for a holding Yahoo can't quote reliably |
| `list_portfolio`             | List current portfolio holdings (triggers an opportunistic price refresh) |
| `add_calendar_event`         | Flag a notable date (earnings, dividend, macro, catalyst, other)        |
| `list_upcoming_events`       | List calendar events in a date range (defaults to next 30 days, active only) |
| `remove_calendar_event`      | Soft-remove a calendar event, by id or in bulk by ticker                 |

## Market data / news providers

`providers/prices.ts` and `providers/news.ts` each define an interface plus
one or more implementations, selected via `PRICE_PROVIDER=`/`NEWS_PROVIDER=`.

**Prices** default to `yahoo` (`YahooFinancePriceProvider`) - real, free,
delayed quotes via [`yahoo-finance2`](https://github.com/gadicc/yahoo-finance2),
a maintained TypeScript client for the same unofficial Yahoo Finance
endpoints the Python `yfinance` library uses. It's modeled on this
dashboard's actual watch-list (UK-market tickers): symbols get a `.L`
(LSE/AIM) suffix unless their `exchange` looks like a US one (NASDAQ, NYSE,
etc, from the seeded AAPL/MSFT examples), and Yahoo's pence-vs-pounds
quirk for LSE instruments (`currency: "GBp"`, lowercase p) is normalized to
whole-pound GBP. It's unofficial with no SLA or published rate limit, so
`services/priceRefresh.ts` only refreshes each ticker's cached quote every
few hours - plenty for "delayed/previous close," and easy on an API that
could rate-limit or change without notice. Set `PRICE_PROVIDER=mock` to
fall back to `MockPriceProvider` (deterministic fake GBP data, no network
calls) for offline dev/demo.

**News** still only ships a mock. Implement `NewsProvider` against a real
API (NewsAPI, Finnhub, etc.), add a `case` to `getNewsProvider()`, and set
`NEWS_PROVIDER=` - no other code needs to change. Same pattern to add a
different real price source later (Alpha Vantage, Polygon, etc.) alongside
or instead of `yahoo`.

## Price history & backfill CLI

`GET /api/tickers/:symbol/history` returns whatever's in the `price_history`
table for that ticker (ascending by date) - `[]` if nothing's been
backfilled yet. It's what the frontend's ticker-detail chart reads; nothing
in the request path calls out to the price provider itself, so the table
has to be populated separately. That's deliberate: a chart render shouldn't
also trigger a live network call, and backfilling a year of daily closes
for every ticker on every quote refresh would be wasteful and easy to
rate-limit.

Populate (or refresh) it with the `backfill-history` CLI, run inside the
service container so it shares the container's `DATABASE_URL` and
`PRICE_PROVIDER`:

```bash
# One ticker, default lookback (365 days)
docker compose exec service node dist/cli/backfillHistory.js --symbol=AAL

# Every ticker with an *active* watch-list item or portfolio holding
# right now - not one only ever mentioned in a past article, and not one
# you've since removed from both
docker compose exec service node dist/cli/backfillHistory.js --all

# A short daily top-up rather than a full re-backfill - safe to run on a
# schedule (e.g. a cron entry after market close) since existing dates are
# overwritten in place, not duplicated. A few days' buffer, not just 1,
# covers a run that lands right after a weekend or market holiday.
docker compose exec service node dist/cli/backfillHistory.js --all --days=3

# Custom lookback
docker compose exec service node dist/cli/backfillHistory.js --symbol=AAL --days=90
```

It upserts on `(ticker_symbol, price_date)`, so re-running it (e.g. on a
schedule) is safe and just refreshes/extends what's there rather than
duplicating rows. With `--all`, a failure fetching one ticker is logged and
skipped rather than aborting the rest; the process exits non-zero if any
ticker failed. `--all`'s scope is deliberately narrower than "every ticker
the system has ever heard of" (`listTrackedTickers` in `src/db/queries.ts`)
so a recurring job doesn't keep spending API calls on a ticker a past
research article mentioned once, or one you've since removed from both the
watch-list and portfolio - use `--symbol=<TICKER>` to backfill one of those
on demand instead.

Run it against `PRICE_PROVIDER=mock` (the default in local dev without a
`.env`) to backfill deterministic fake data with no network calls - useful
for demoing the chart. Real backfills need `PRICE_PROVIDER=yahoo` (the
container's default), which uses `yahoo-finance2`'s `chart()` endpoint -
same unofficial API and pence-normalization caveat as the live quotes
described above.

## News summary ("Generate News Summary" button)

Each ticker page has a "Generate News Summary" button that summarizes that
ticker's recent news (whatever's already in `news_items` - it doesn't
itself trigger a news refresh) via an LLM call, and shows the result with a
"Generated <timestamp>" line underneath. It's on-demand only - a real API
call with real latency and (for the real provider) real cost, so nothing
generates one automatically.

- `GET /api/tickers/:symbol/news-summary` - read-only, returns the
  currently-stored summary (`null` if none has been generated yet - that's
  a normal state, not a 404; only an unknown ticker 404s).
- `POST /api/tickers/:symbol/news-summary` - generates a fresh one
  (overwriting any previous one - only the latest is ever kept) and returns
  it. This is what the button calls.

`providers/summaries.ts` follows the same pluggable-provider pattern as
prices/news, selected via `SUMMARY_PROVIDER=`:

- **`gemini`** (the default) - calls Google's Gemini `generateContent`
  endpoint, following the request shape from the project's reference doc:
  a prompt of the form "Summarize the following scraped web page
  contents:\n\nArticle 1:\n[text]\n\nArticle 2:\n[text]...". For each news
  item it best-effort *scrapes* the article's own URL for real page text
  (strips `<script>`/`<style>`/tags, caps length) rather than only using
  the short cached headline/snippet, falling back to the headline+snippet
  when a fetch fails - expected for plenty of sites (paywalls, bot
  checks, JS-rendered pages, dead links), not a bug. Requires
  `GEMINI_API_KEY` (get one at <https://aistudio.google.com/apikey>);
  `GEMINI_MODEL` defaults to `gemini-3.6-flash`. **Not independently
  network-verified from within this sandbox** - its egress policy blocks
  both `generativelanguage.googleapis.com` and the news sites being
  scraped, the same disclosed limitation as the Yahoo-backed providers
  above. The request/response shape matches Gemini's published API and the
  project's own reference doc exactly; worth a first real run to confirm.
- **`mock`** - deterministic placeholder text built from the cached
  headlines, no network calls, no API key needed. Use this for offline
  dev/demo, or if you haven't got a Gemini key yet.

## Auth

A single shared bearer token (`API_KEY`) gates both the REST API and the MCP
server. That's adequate for a single-user dashboard; if this ever needs
multiple users, replace `api/auth.ts` with something more granular.
