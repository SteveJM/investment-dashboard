# Investment Dashboard

WARNING: This repository contains 100% LLM generated code. It has not been scanned for security vulnerabilities. DO NOT store
sensitive data in this system (Peronal details, account numbers, etc).

This system comprises three containers:

| Container  | What it is                                            | Ports (default)              |
|------------|--------------------------------------------------------|-------------------------------|
| `database` | Postgres 16, schema baked into the image                | 5432                           |
| `service`  | Node/TypeScript: REST API + MCP server (shared DB layer) | 4000 (REST API), 4001 (MCP)   |
| `frontend` | React/Vite SPA, served by nginx, proxies `/api` to `service` | 8080 → nginx :80          |

```
database/   Postgres image (schema + seed data baked in)
service/    REST API + MCP server
frontend/   React dashboard
docker-compose.yml
```

Each folder has its own README with more detail.

## What it does

- **Calendar**: notable dates flagged by research articles (earnings, dividends, macro, catalysts).
- **Watch-list**: tickers surfaced by research articles (or added manually), each showing an account tag, an optional "buy below" target price, and a latest-price quote in GBP - real, free, delayed quotes via `yahoo-finance2` by default (`service/providers/prices.ts`), refreshed every few hours per ticker.
- **News**: recent headlines for everything on the watch-list - real articles with real links via `yahoo-finance2`'s search endpoint by default (`service/providers/news.ts`), refreshed every few hours per ticker. Each headline is tracked read/unread - clicking through marks it read, and read items render paled-out.
- **Articles**: the research write-ups themselves. Ticker symbols and calendar entries link back to the article that produced them.

Research articles are meant to be written by Claude via the **MCP server**
(`create_article` and friends) - e.g. as part of a weekly scheduled research
task - though the REST API also supports manual entry for everything.

## Running it

```bash
cp .env.example .env   # edit if you want a non-default password/API key
docker compose up --build
```

Then:

- Dashboard: <http://localhost:8080>
- REST API directly: <http://localhost:4000/api/health>
- MCP server: `http://localhost:4001/mcp` (Streamable HTTP transport, `Authorization: Bearer <API_KEY>`)

First boot creates the schema and a small example article/watch-list/calendar
entry (`database/init/002_seed.sql`) so the dashboard isn't empty. Delete
that file (or the `db-data` volume, for a totally clean slate) if you don't
want it.

## Connecting Claude to the MCP server

Full protocol details (auth, session handshake, every tool's input schema) are in [docs/MCP_INTEGRATION.md](docs/MCP_INTEGRATION.md) - written for handing to another system/agent that needs to populate this dashboard programmatically.

Point a Claude session - most usefully a scheduled weekly research task - at
`http://<host>:4001/mcp` as a custom MCP connector, with header
`Authorization: Bearer <API_KEY>` (same value as `service`'s `API_KEY` env
var). From there it can call `create_article` to publish a research write-up
that automatically populates the watch-list and calendar, or use the other
tools (`add_watchlist_item`, `add_calendar_event`, `list_watchlist`,
`list_upcoming_events`, `search_articles`, `get_article`,
`remove_watchlist_item`) directly. See `service/README.md` for the full tool
list and descriptions.

If this ever runs somewhere Claude reaches over the public internet, put it
behind TLS (e.g. an ALB/CloudFront in front of it on AWS) - the bearer token
alone is not enough on an unencrypted connection.

## Notes on what's stubbed

Both prices and news now default to real (free, unofficial) sources via
`yahoo-finance2`, the same underlying data `yfinance` uses in Python - see
`service/README.md` for caveats (delayed, no SLA, LSE pence-vs-pounds handling
for prices; whichever outlet Yahoo Finance itself surfaces for news, not a
curated source list). Set `PRICE_PROVIDER=mock` / `NEWS_PROVIDER=mock` to fall
back to deterministic fake data with no network calls for either. Swapping in
a different real source is a single file (implement the interface) plus one
env var (`PRICE_PROVIDER` / `NEWS_PROVIDER`).

## Deploying beyond docker-compose

Each image is self-contained (the DB image bakes in its own migrations, see
`database/README.md`), so this maps reasonably directly onto three ECS
Fargate services / task definitions, an RDS Postgres instance instead of the
`database` container, and an ALB in front of `frontend` (and optionally
`service` if you want the MCP endpoint reachable directly rather than only
via the frontend's proxy). Nothing here assumes docker-compose specifically
beyond the compose file itself.

## Verified

- `database/init/*.sql` applied cleanly against a real Postgres 16 instance.
- `service` type-checks, builds, and was run end-to-end against that
  database: REST endpoints exercised directly, and the MCP server verified
  over real Streamable HTTP (initialize → tools/list → `create_article` →
  confirmed via REST that the watch-list/calendar were updated).
- `frontend` type-checks and builds to static assets; served and smoke-tested
  via `vite preview`.
- `docker compose config` validates the full compose file.
- The three `Dockerfile`s could **not** be built in this sandbox (its network
  policy blocks Docker Hub, only npm/PyPI/etc are reachable) - build them on
  your machine to confirm (`docker compose build`). They're straightforward
  multi-stage builds; nothing in them depends on sandbox-specific behavior.
