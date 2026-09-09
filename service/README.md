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
    news.ts             pluggable news provider (mock implementation only, for now)
  services/
    newsRefresh.ts       refreshes stale watch-list news from the news provider
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
| `list_upcoming_events`       | List calendar events in a date range (defaults to next 30 days)         |

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

## Auth

A single shared bearer token (`API_KEY`) gates both the REST API and the MCP
server. That's adequate for a single-user dashboard; if this ever needs
multiple users, replace `api/auth.ts` with something more granular.
