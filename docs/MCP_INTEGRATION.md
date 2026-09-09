# MCP integration - Investment Dashboard

Reference for any external system (your ISA project included) that wants to
populate the dashboard programmatically via MCP, rather than through the
REST API directly. Source of truth is `service/src/mcp/server.ts` and
`service/src/mcp/http.ts` - this doc is a summary of what's implemented
there.

## Connection

| | |
|---|---|
| Transport | MCP **Streamable HTTP** (spec revision `2025-03-26`) |
| Endpoint | `POST/GET/DELETE http://<host>:4001/mcp` |
| Auth | `Authorization: Bearer <API_KEY>` on every request (same header the REST API uses, same env var) |
| Default port | `4001`, published on the host by `docker-compose.yml` (`"4001:4001"`) |

Reachability depends on where the ISA project runs relative to this stack:

- **Same Docker network** (e.g. added as another `docker-compose.yml` service) → `http://service:4000` for the REST API / `http://service:4001/mcp` for MCP, using the internal service name, no published port needed.
- **Same host, different process** → `http://localhost:4001/mcp`.
- **Different machine** → `http://<host-or-IP>:4001/mcp`. There's no TLS in front of this by default - see "Security" below before doing this over an untrusted network.

If the ISA project can use an existing MCP client library (official SDKs
exist for TypeScript, Python, and others), point it at that URL with that
header and it will handle the handshake below for you. The rest of this doc
is for hand-rolling the JSON-RPC calls if it can't.

## Session lifecycle (if hand-rolling)

1. **`initialize`** - `POST` a JSON-RPC `initialize` request. The response includes an `Mcp-Session-Id` response header. Save it.
2. **`notifications/initialized`** - `POST` this notification (no `id` field), with the `Mcp-Session-Id` header now included. Server replies `202 Accepted`, no body.
3. **Tool calls** - `POST` `tools/call` requests, always with the `Mcp-Session-Id` header from step 1.

Every request needs `Content-Type: application/json` and `Accept: application/json, text/event-stream` - the server streams responses as SSE (`event: message` / `data: {...}`) even for what's logically a single response.

If a request arrives without a valid/known session, the server silently
starts a new session rather than erroring - convenient for a single client,
but means a lost session id just looks like a fresh conversation with no
history (there isn't any server-side conversation state beyond tool
call routing, so this is harmless).

### Worked example (curl)

```bash
API_KEY=devkey
BASE=http://localhost:4001/mcp

# 1. initialize - grab the session id from the response headers
SESSION_ID=$(curl -sS -i -X POST "$BASE" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"isa-project","version":"1.0.0"}}}' \
  | grep -i '^mcp-session-id:' | awk '{print $2}' | tr -d '\r')

# 2. notifications/initialized
curl -sS -o /dev/null -X POST "$BASE" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

# 3. call a tool
curl -sS -X POST "$BASE" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_watchlist","arguments":{}}}'
```

`tools/list` (same shape, `"method":"tools/list"`, no `params` needed) returns the full JSON Schema for every tool below, generated straight from the Zod definitions - useful if you want to validate payloads client-side before sending.

## Tools

All tool results come back as `content: [{ type: "text", text: "<JSON>" }]` - the text is a JSON-stringified version of the object shown per tool below. On failure, the same shape comes back with `isError: true` and a human-readable message in `text` (not a JSON-RPC protocol error - check `isError`, not just HTTP status).

### `create_article` - the primary write path

Publishes a research article and, in one transaction, upserts every ticker it references (optionally onto the watch-list) and files every calendar date it flags. This is what a research-generation pipeline should call once per article - not `add_watchlist_item`/`add_calendar_event` separately - so everything stays linked back to its source article on the dashboard.

Input:

```ts
{
  title: string;                // required
  summary?: string;             // shown in list views
  body: string;                 // required, markdown supported
  conviction?: "high" | "medium" | "low";
  tickers?: {
    symbol: string;              // required, e.g. "AAPL"
    name?: string;                // required THE FIRST TIME this symbol is ever used anywhere in the system
    exchange?: string;
    context?: string;             // why this ticker is relevant to the article
    addToWatchlist?: boolean;     // add/update it on the watch-list, sourced from this article
    account?: string;             // which account this ticker relates to (one of your configured ACCOUNTS values), if adding it to the watch-list
    buyBelow?: number;            // target price - flag as a candidate purchase below this, if adding it to the watch-list
  }[];
  calendarEvents?: {
    date: string;                 // required, "YYYY-MM-DD"
    title: string;                // required
    description?: string;
    eventType?: "earnings" | "dividend" | "macro" | "catalyst" | "other";  // defaults to "other"
    ticker?: string;               // symbol this date relates to, if any - must already be known or be in `tickers` above
  }[];
}
```

Example call:

```json
{
  "name": "create_article",
  "arguments": {
    "title": "NVDA: high conviction into GTC",
    "summary": "GPU demand signals remain strong ahead of the keynote.",
    "body": "## Thesis\n\nFull markdown body here...",
    "conviction": "high",
    "tickers": [
      { "symbol": "NVDA", "name": "NVIDIA Corporation", "context": "GTC catalyst", "addToWatchlist": true, "account": "ISA", "buyBelow": 120.5 }
    ],
    "calendarEvents": [
      { "date": "2026-10-01", "title": "NVDA GTC keynote", "eventType": "catalyst", "ticker": "NVDA" }
    ]
  }
}
```

Returns the created article (id, generated `slug`, everything above plus `createdAt`/`updatedAt`).

### `add_watchlist_item`

Add a ticker to the watch-list directly, or update conviction/notes/account/buyBelow if it's already there. `name` is required only the first time a symbol is used. Like `conviction`/`notes`/`account`, `buyBelow` here only ever overwrites-or-preserves (it's ignored if omitted) - it can never explicitly *clear* the value back to unset. Use `set_watchlist_account` / `set_watchlist_buy_below` for that.

```ts
{ symbol: string; name?: string; exchange?: string; conviction?: "high"|"medium"|"low"; notes?: string; account?: string; buyBelow?: number; }   // account: one of your configured ACCOUNTS values
```

### `set_watchlist_account`

Sets, or explicitly clears, which account a watch-list item relates to. This is the one to use for "unassign this item's account" - `add_watchlist_item` can't do that (see above).

```ts
{ symbol: string; account?: string; }   // one of your configured ACCOUNTS values; omit `account` to clear it back to unassigned
```

### `set_watchlist_buy_below`

Sets, or explicitly clears, a watch-list item's "buy below" target price - the price threshold used to flag it as a candidate purchase on the dashboard. This is the one to use for "clear this item's target price" - `add_watchlist_item` can't do that (see above).

```ts
{ symbol: string; buyBelow?: number; }   // omit `buyBelow` to clear it back to unset
```

### `remove_watchlist_item`

Soft-removes a ticker from the watch-list (history kept, status flips to `removed`).

```ts
{ symbol: string; }
```

### `list_watchlist`

```ts
{ status?: "active" | "removed" | "all"; }   // defaults to "active"
```

Before listing, this refreshes the cached `quote` (see below) for any active item whose quote is missing or over a minute old - so a call to this tool can take slightly longer than the others while that happens, and always reflects a recent price.

### `add_portfolio_holding`

Adds a holding to the portfolio - tickers you actually own, tracked independently of the watch-list (a ticker can be on neither, either, or both). If this (symbol, account) pair already exists, its quantity and average cost are overwritten with the values given here (not merged/preserved like `add_watchlist_item`'s account/buyBelow fields - re-adding a holding means "this is now the position").

```ts
{ symbol: string; name?: string; exchange?: string; account: string; quantity: number; averageCost: number; }
// account: one of your configured ACCOUNTS values
// quantity: number of shares/units held, must be > 0
// averageCost: average cost per share/unit in GBP, must be > 0
```

### `set_portfolio_holding`

Updates the quantity and/or average cost of an existing holding, addressed by ticker + account. Unlike `add_portfolio_holding`, only the field(s) given are touched - omit one to leave it as-is.

```ts
{ symbol: string; account: string; quantity?: number; averageCost?: number; }
```

### `remove_portfolio_holding`

Soft-removes a portfolio holding (history kept, status flips to `removed`). Addressed by ticker + account, since the same ticker can be held separately across multiple accounts. There's no "change account" tool - moving a holding between accounts is modeled as `remove_portfolio_holding` followed by `add_portfolio_holding` under the new account (an explicit transfer), since account is part of a holding's identity here.

```ts
{ symbol: string; account: string; }
```

### `list_portfolio`

```ts
{ account?: string; status?: "active" | "removed" | "all"; }   // status defaults to "active"
```

Before listing, this refreshes the cached `quote` for any active holding whose quote is missing or over a few hours old - same mechanism as `list_watchlist`'s quote refresh, but tracked independently (a ticker that's both held and watched has two separate cache columns, refreshed on their own schedules).

### `add_calendar_event`

Same shape as one entry of `create_article`'s `calendarEvents`, plus `ticker` must already exist:

```ts
{ date: string; title: string; description?: string; eventType?: "earnings"|"dividend"|"macro"|"catalyst"|"other"; ticker?: string; }
```

### `list_upcoming_events`

```ts
{ from?: string; to?: string; ticker?: string; }   // from/to default to today .. +30 days
```

### `search_articles`

```ts
{ query: string; }   // matches title/summary/body, case-insensitive substring
```

### `get_article`

```ts
{ slug: string; }   // slug as returned by create_article / search_articles / list results
```

## Data model notes relevant to a producer

- **Tickers are upserted, not pre-registered.** The first time your pipeline mentions a symbol (via `create_article.tickers[]`, `add_watchlist_item`, or a calendar event's `ticker`), include `name` (and `exchange` if you have it). After that, `name` is optional and ignored unless you're deliberately renaming it.
- **Slugs are auto-generated** from `title` (or an explicit `slug` if you pass one) and de-duplicated automatically (`-2`, `-3`, ...) - don't try to guess them for a `create_article` call; read them back from the response.
- **Conviction is a 3-value enum** (`high`/`medium`/`low`) at both the article and watch-list-item level - they're independent fields (an article's overall conviction vs. a specific ticker's watch-list conviction), matching how `create_article` sets watch-list conviction from the article's top-level `conviction`, not per-ticker.
- **Idempotency:** re-running `add_watchlist_item` for a symbol already on the list updates it in place (no duplicates). `create_article` always creates a new article row per call - it's not idempotent, so don't call it twice for the same research write-up.
- **Account is validated against the `ACCOUNTS` env var** (comma-separated, e.g. `ISA,Taxable,Pension` by default - see `service/README.md`) rather than a hard-coded list, so it varies per deployment; any value not in that list is rejected at the API/MCP layer (there's no DB-level constraint any more). Fetch the actual configured list via `GET /api/accounts`. It's a single value per watch-list item, not a list (a ticker can't be tagged against more than one account today).
- **`buyBelow` is a plain positive number** (no currency field - it's just a target price you set yourself) enforced by a DB constraint (`> 0` or `NULL`). It's a manual reference value the dashboard displays alongside each watch-list item, and the dashboard now highlights an item green when its `quote.price` is at or below `buyBelow`.
- **Every watch-list item carries a `quote`** - `{ price: number; changePercent: number; currency: string; asOf: string }` or `null` if it hasn't been fetched yet. This is read-only output (there's no tool to set it): it's refreshed opportunistically from the price provider (`service/src/providers/prices.ts`) whenever `list_watchlist` or the REST `/api/watchlist` endpoint is called, throttled to once every few hours per symbol (real quotes, not a live feed - see `service/README.md`). The default provider is `yahoo-finance2` (real, free, delayed quotes; `currency` is `"GBP"` for UK tickers); set `PRICE_PROVIDER=mock` for deterministic fake GBP data with no network calls.
- **Portfolio holdings are independent of the watch-list** - a ticker can be on neither, either, or both; there's no reference between a `portfolio_holdings` row and a `watchlist_items` row. A holding is keyed on `(ticker_symbol, account)`, not `ticker_symbol` alone - the same ticker can be a distinct position in more than one account, unlike a watch-list item. `quantity` and `averageCost` are plain positive numbers (`averageCost` is GBP, same convention as `buyBelow`); each holding carries its own `quote`, same shape and refresh mechanism as a watch-list item's.

## Security

The bearer token is the only auth. It's adequate for a single-user setup on
a trusted network (localhost, a private Docker network, your own LAN). If
the ISA project runs somewhere else - a different machine, a cloud job - and
has to reach this over the open internet, put TLS in front of it (e.g. an
ALB/nginx with a real cert) before doing that; the token alone over plain
HTTP is crackable by anyone who can see the traffic. Rotate `API_KEY` in
`.env` (and restart `service`) if you ever suspect it's leaked.
