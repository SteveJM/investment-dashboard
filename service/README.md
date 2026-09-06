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
  services/
    newsRefresh.ts       refreshes stale watch-list news from the news provider
    priceRefresh.ts      refreshes stale watch-list quotes from the price provider
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

| Tool                   | Purpose                                                                 |
|-------------------------|--------------------------------------------------------------------------|
| `create_article`        | Publish a research article; optionally references tickers (adding them to the watch-list) and flags calendar dates - all in one transaction |
| `add_watchlist_item`    | Add/update a ticker on the watch-list                                   |
| `remove_watchlist_item` | Soft-remove a ticker from the watch-list                                |
| `add_calendar_event`    | Flag a notable date (earnings, dividend, macro, catalyst, other)        |
| `list_watchlist`        | List current watch-list items                                           |
| `list_upcoming_events`  | List calendar events in a date range (defaults to next 30 days)         |
| `search_articles`       | Search past articles by title/summary/body                              |
| `get_article`           | Fetch a single article by slug                                          |

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

**News** defaults to `yahoo` (`YahooFinanceNewsProvider`) - real headlines
with real article links via the same `yahoo-finance2` package's `search()`
endpoint, given the ticker's company name (falling back to its bare symbol).
It aggregates whichever outlets Yahoo Finance itself surfaces for that
company (Reuters, AP, Bloomberg, MarketWatch, Motley Fool, etc, via each
item's `publisher`) rather than pulling from one curated source - there's no
summary/snippet in Yahoo's response, so `NewsHeadline.summary` is left unset
for this provider. Same unofficial-API caveats as prices apply, so
`services/newsRefresh.ts` also only refreshes each ticker every few hours.
Set `NEWS_PROVIDER=mock` to fall back to `MockNewsProvider` (deterministic
placeholder headlines, no network calls) for offline dev/demo. To wire in a
different real source instead (NewsAPI, Finnhub, etc.), implement
`NewsProvider`, add a `case` to `getNewsProvider()`, and set `NEWS_PROVIDER=`
- no other code needs to change. Same pattern for a different real price
source later (Alpha Vantage, Polygon, etc.) alongside or instead of `yahoo`.

## Accounts

Which accounts a watch-list item can be tagged against is deployment-specific
(whose ISAs/pensions this dashboard actually tracks), so it's the `ACCOUNTS`
env var - comma-separated, e.g. `ISA,Taxable,Pension` (the
default). Validated non-empty at startup; both the REST/MCP request schemas
and `GET /api/accounts` (which the frontend's dropdowns/filters are built
from, rather than keeping their own copy) are built from this same list.
There's no DB-level constraint on the value any more (see
`database/README.md`'s `007_relax_watchlist_account_constraint.sql`) -
validation lives entirely here, so changing `ACCOUNTS` and restarting the
service is enough; no migration needed.

## Auth

A single shared bearer token (`API_KEY`) gates both the REST API and the MCP
server. That's adequate for a single-user dashboard; if this ever needs
multiple users, replace `api/auth.ts` with something more granular.
