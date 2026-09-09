# MCP tools reference

Full reference for every tool the Investment Dashboard's MCP server exposes.
`service/README.md` has a short summary table that links here; this is the
detailed version - exact input schemas, return shapes, and the behavioral
gotchas (upsert vs. overwrite semantics, soft deletes, default values) that
matter when you're actually calling these instead of just reading the REST
routes.

Everything here is generated from what's actually registered in
`src/mcp/server.ts` and implemented in `src/db/queries.ts` as of the
`set_portfolio_manual_price` tool (2026-09-08) - not aspirational. If you add
or change a tool, update this file in the same change.

## Contents

- [Connecting](#connecting)
- [Conventions](#conventions)
- [Data shapes](#data-shapes)
- [Tools: research articles](#tools-research-articles)
- [Tools: watch-list](#tools-watch-list)
- [Tools: portfolio](#tools-portfolio)
- [Tools: calendar](#tools-calendar)
- [REST ↔ MCP parity](#rest--mcp-parity)

## Connecting

The MCP server runs on its own HTTP listener, separate from the REST API,
using the **Streamable HTTP transport** (MCP spec 2025-03-26+) - see
`src/mcp/http.ts`.

| | |
|---|---|
| URL | `http://<host>:<MCP_PORT>/mcp` (default port `4001`; in docker-compose, `http://localhost:4001/mcp`) |
| Auth | `Authorization: Bearer <API_KEY>` header on every request - same token as the REST API, checked before any MCP handshake logic runs. Missing/wrong token → plain `401 {"error": "Unauthorized"}`, not an MCP-shaped error. |
| Session | The SDK issues a session id on the first (`initialize`) request; every request after that must carry it back in an `Mcp-Session-Id` header. One `McpServer` + transport instance is created per session (`transports` map in `http.ts`) and torn down when the session closes. |

To point a Claude session at it - e.g. a scheduled weekly research task -
add it as a custom MCP connector with that URL and header. If this is ever
reachable over the public internet rather than just docker-compose's
internal network, put TLS in front of it (an ALB/CloudFront on AWS, say) -
the bearer token alone is not meaningful protection over plain HTTP.

## Conventions

These hold across every tool below; noted here once rather than repeated on
each one.

- **Money is GBP.** `averageCost`, `buyBelow`, and manual/automatic quote
  prices are all plain numbers in whole pounds sterling. There is no
  per-tool currency parameter - the one exception, a portfolio holding's
  *automatic* quote, carries its own `currency` field because Yahoo
  occasionally returns a non-GBP-denominated instrument; see
  [Data shapes](#data-shapes).
- **Symbols are case-normalized.** Every tool that takes a `symbol` upper-cases
  it before touching the database, so `"aal"`, `"AAL"`, and `"Aal"` all
  address the same ticker.
- **Accounts are a closed, deployment-configured list.** Every `account`
  parameter is a Zod enum built from the `ACCOUNTS` env var at startup (see
  `src/config.ts`), not a free-text string - passing anything not in that
  list is rejected before the tool handler even runs. Changing the set of
  valid accounts means editing `ACCOUNTS` and redeploying the service; ask
  whoever runs this deployment what the current list is if you're not sure
  (`GET /api/accounts` on the REST side, no MCP tool exposes it directly).
- **"Remove" is always a soft delete.** Watch-list and portfolio removals set
  `status: 'removed'` and keep the row (history/audit trail); nothing here
  hard-deletes user data. A removed item still shows up if you explicitly
  ask for `status: 'removed'` or `'all'` on a list tool.
- **Upsert semantics differ by resource - read this carefully:**
  - `add_watchlist_item` **preserves** any field you omit if the ticker is
    already on the watch-list (SQL `COALESCE`) - it's "fill in only what you
    give me."
  - `add_portfolio_holding` **always overwrites** `quantity` and
    `averageCost` if the (ticker, account) pair already exists - re-adding a
    holding means "this is now the position," not "patch what changed." Use
    `set_portfolio_holding` instead if you only want to touch one field.
  - `set_watchlist_account`, `set_watchlist_buy_below`, and
    `set_portfolio_manual_price` all use "omit/null clears the value back to
    unset" - they exist specifically because the upsert tools above can
    *set* a field but can't *null it back out*.
- **Every mutation returns the full updated resource**, not just an ack - so
  you don't need a follow-up `list_*`/`get_*` call to see the result of an
  add/update/remove.
- **Response envelope.** Every tool returns MCP's standard
  `{ content: [{ type: 'text', text: '<JSON>' }] }` shape - the `text` is the
  resource, pretty-printed with `JSON.stringify(data, null, 2)`. The JSON
  bodies shown below in this doc are that inner text, already parsed, for
  readability.
- **Errors come two ways:**
  1. **Schema validation** (wrong type, missing required field, `account` not
     in the configured list, negative price, etc.) is rejected by the MCP
     SDK/Zod before your tool call handler runs at all, as a standard MCP
     protocol error - not one of the `isError` results below.
  2. **"Not found" / business-logic errors** (no watch-list item for that
     symbol, no portfolio holding for that ticker+account, etc.) come back as
     a *successful* MCP call whose result has `isError: true` and a plain
     English `content[0].text` message - e.g.
     `No portfolio holding for XYZ in "Steve ISA"`. Check `isError`, not just
     whether the call itself threw.

## Data shapes

Referenced by multiple tools below rather than repeated on each one.

**`Ticker`**
```ts
{ symbol: string, name: string, exchange: string | null, createdAt: string }
```

**`WatchlistQuote`** (a cached price snapshot; shared shape for both
watch-list items and portfolio holdings)
```ts
{
  price: number,          // GBP
  changePercent: number,  // day change, %; always 0 for a manual portfolio price
  currency: string,       // "GBP" - Yahoo's pence quotes are normalized before this is set
  asOf: string,           // ISO 8601 - when *this service* fetched/set it, not Yahoo's own quote timestamp
  source?: 'auto' | 'manual'  // only ever 'manual' on a portfolio holding; absent/undefined = automatic
}
```

**`WatchlistItem`**
```ts
{
  id: string,
  ticker: Ticker,
  conviction: 'high' | 'medium' | 'low' | null,
  status: 'active' | 'removed',
  notes: string | null,
  account: string | null,
  buyBelow: number | null,
  quote: WatchlistQuote | null,   // null until the first automatic refresh populates it
  sourceArticle: { id: string, title: string, slug: string } | null,
  addedAt: string,
  updatedAt: string
}
```

**`PortfolioHolding`**
```ts
{
  id: string,
  ticker: Ticker,
  account: string,
  quantity: number,
  averageCost: number,            // GBP, per share/unit
  status: 'active' | 'removed',
  quote: WatchlistQuote | null,   // manual override (if set) always wins over the automatic quote
  createdAt: string,
  updatedAt: string
}
```

**`ArticleTickerRef`**
```ts
{ symbol: string, name: string, context: string | null }
```

**`ArticleSummary`**
```ts
{
  id: string,
  title: string,
  slug: string,
  summary: string | null,
  conviction: 'high' | 'medium' | 'low' | null,
  source: 'mcp' | 'manual',
  publishedAt: string,
  tickers: ArticleTickerRef[]
}
```

**`Article`** (= `ArticleSummary` plus the full body)
```ts
ArticleSummary & { body: string, createdAt: string, updatedAt: string }
```

**`CalendarEvent`**
```ts
{
  id: string,
  date: string,                                   // YYYY-MM-DD
  title: string,
  description: string | null,
  eventType: 'earnings' | 'dividend' | 'macro' | 'catalyst' | 'other',
  ticker: { symbol: string, name: string } | null,
  sourceArticle: { id: string, title: string, slug: string } | null,
  createdAt: string
}
```

## Tools: research articles

### `create_article`

Publishes a research article/briefing. This is the tool the whole MCP
server exists for - the intended flow is a scheduled research task calling
this once per write-up, with the tickers it discusses and any dates it flags
threaded through in the same call so the watch-list and calendar populate
automatically, in one transaction.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `title` | string (min 1 char) | yes | |
| `summary` | string | no | One or two sentences, shown in list views |
| `body` | string (min 1 char) | yes | Full body; markdown supported (rendered as-is by the frontend, not sanitized against arbitrary HTML) |
| `conviction` | `'high' \| 'medium' \| 'low'` | no | Overall conviction for the article |
| `tickers[]` | array of objects (below) | no | |
| `tickers[].symbol` | string | yes (per entry) | |
| `tickers[].name` | string | conditionally | Required the *first* time this symbol is ever referenced anywhere in the system; optional afterwards |
| `tickers[].exchange` | string | no | |
| `tickers[].context` | string | no | Why this ticker is relevant to *this* article |
| `tickers[].addToWatchlist` | boolean | no | If true, also upserts this ticker onto the watch-list, with `sourceArticle` pointing back at this article |
| `tickers[].account` | account enum | no | Only meaningful with `addToWatchlist: true` |
| `tickers[].buyBelow` | number > 0 | no | Only meaningful with `addToWatchlist: true` |
| `calendarEvents[]` | array of objects (below) | no | |
| `calendarEvents[].date` | string `YYYY-MM-DD` | yes (per entry) | |
| `calendarEvents[].title` | string | yes (per entry) | |
| `calendarEvents[].description` | string | no | |
| `calendarEvents[].eventType` | `'earnings' \| 'dividend' \| 'macro' \| 'catalyst' \| 'other'` | no | Defaults to `'other'` if omitted |
| `calendarEvents[].ticker` | string | no | Symbol this date relates to |

Behavior notes:
- **Slug** is auto-generated from `title` (lower-cased, non-alphanumerics
  collapsed to `-`, trimmed, capped at 80 chars) and de-duplicated with a
  `-2`, `-3`, ... suffix if it collides with an existing article. You can't
  pass a slug explicitly through this tool.
- **`source`** on the created article is always `'mcp'` when called through
  this tool (the REST `POST /api/articles` route hard-codes `'manual'`
  instead) - it's how the frontend/API distinguish "Claude wrote this" from
  "typed in by hand," even though both go through the exact same
  `createArticle()` function underneath.
- **`publishedAt`** defaults to the time of the call (`now()`) if not given.
- Everything - the article row, every referenced ticker (upserted, created
  if new), every `article_tickers` link, every watch-list add, every
  calendar event - happens in one Postgres transaction. If anything fails,
  nothing is written.
- **The `addToWatchlist` upsert here is *not* the same as calling
  `add_watchlist_item`.** It shares the ticker's `account`/`buyBelow` with
  `add_watchlist_item`'s "preserve if omitted" behavior, but `conviction`
  and the watch-list item's `sourceArticle` link are **hard-overwritten**
  from this article's own top-level `conviction` field, not coalesced. So
  publishing a second article with `addToWatchlist: true` for a ticker
  that's already on the watch-list - and no `conviction` set on *this*
  article - will null out whatever conviction it had before, and re-point
  `sourceArticle` at this new article. There's also no way to set a
  watch-list item's `notes` through this path (only `add_watchlist_item`
  can). If you want to add a ticker to the watch-list without touching its
  existing conviction, do that as a separate `add_watchlist_item` call
  instead of via `addToWatchlist` here.

Example call arguments:
```json
{
  "title": "Anglo American - smaller companies exposure looking cheap",
  "summary": "AAL trading well below NAV after the Anglo/Teck spin-off noise settles.",
  "body": "## Thesis\n\nFull markdown write-up goes here...",
  "conviction": "medium",
  "tickers": [
    { "symbol": "AAL", "name": "Anglo American plc", "exchange": "LSE",
      "context": "Core position, adding on weakness",
      "addToWatchlist": true, "account": "Steve ISA", "buyBelow": 22.50 }
  ],
  "calendarEvents": [
    { "date": "2026-09-25", "title": "AAL half-year results", "eventType": "earnings", "ticker": "AAL" }
  ]
}
```

Example result (`Article`):
```json
{
  "id": "b3f1...",
  "title": "Anglo American - smaller companies exposure looking cheap",
  "slug": "anglo-american-smaller-companies-exposure-looking-cheap",
  "summary": "AAL trading well below NAV after the Anglo/Teck spin-off noise settles.",
  "body": "## Thesis\n\nFull markdown write-up goes here...",
  "conviction": "medium",
  "source": "mcp",
  "publishedAt": "2026-09-08T12:00:00.000Z",
  "tickers": [
    { "symbol": "AAL", "name": "Anglo American plc", "context": "Core position, adding on weakness" }
  ],
  "createdAt": "2026-09-08T12:00:00.000Z",
  "updatedAt": "2026-09-08T12:00:00.000Z"
}
```

Errors: any thrown error (e.g. a database constraint failure) comes back as
`isError: true` with the error's message as text.

### `search_articles`

Simple `ILIKE`-based search across `title`, `summary`, and `body`, most
recent first.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `query` | string (min 1 char) | yes | Substring match, case-insensitive; no ranking/relevance beyond `published_at DESC` |

Returns: `ArticleSummary[]` (bodies are *not* included - use `get_article`
for the full body). Empty array, not an error, if nothing matches.

### `get_article`

Fetches one article's full content by slug.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `slug` | string | yes | As returned by `create_article` or `search_articles` |

Returns: `Article` (includes `body`). Errors with
`No article with slug "<slug>"` (`isError: true`) if it doesn't exist.

## Tools: watch-list

Tickers you're *watching*, independent of what you actually *own* - see
[Tools: portfolio](#tools-portfolio) for holdings. A ticker can be on
neither, either, or both.

### `add_watchlist_item`

Adds a ticker to the watch-list, or updates it if already there.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `symbol` | string | yes | |
| `name` | string | conditionally | Required the first time this symbol is ever referenced |
| `exchange` | string | no | |
| `conviction` | `'high' \| 'medium' \| 'low'` | no | |
| `notes` | string | no | |
| `account` | account enum | no | |
| `buyBelow` | number > 0 | no | Target price - flags the item as a buy candidate when its quote is at or below this |

Behavior notes: **upsert preserves omitted fields** (SQL `COALESCE`) - see
[Conventions](#conventions). Calling this again for an existing symbol with
only `conviction` set does *not* clear `notes`/`account`/`buyBelow`; it
leaves them as they were. To explicitly clear `account` or `buyBelow` back
to unset, use `set_watchlist_account` / `set_watchlist_buy_below` instead -
this tool has no way to null a field back out.

Returns: `WatchlistItem`, with `quote: null` until the next automatic price
refresh (triggered opportunistically by `list_watchlist`, not by this tool).

### `set_watchlist_account`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `symbol` | string | yes | |
| `account` | account enum | no | **Omit entirely to clear the account back to unassigned** |

Note the clearing mechanic is different from its REST equivalent: this MCP
tool clears by *omitting* `account`, while `PATCH /api/watchlist/:symbol/account`
clears by sending an explicit `{"account": null}` body (its schema is
`.nullable()`, not `.optional()`). Same end effect, different shape - don't
assume `{"account": null}` works here (it'll fail schema validation, since
this parameter is a plain optional enum with no `null` variant).

Returns: `WatchlistItem`. Errors with `No watch-list item for <symbol>`
(`isError: true`) if the symbol isn't on the watch-list.

### `set_watchlist_buy_below`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `symbol` | string | yes | |
| `buyBelow` | number > 0 | no | **Omit entirely to clear the buy-below target back to unset** |

Same omit-to-clear vs. `null`-to-clear asymmetry with its REST equivalent as
`set_watchlist_account` above.

Returns: `WatchlistItem`. Same not-found error shape as above.

### `remove_watchlist_item`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `symbol` | string | yes | |

Soft delete - sets `status: 'removed'`. Returns the now-removed
`WatchlistItem` (not an error) on success; errors with
`No watch-list item for <symbol>` if it was never there.

### `list_watchlist`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `status` | `'active' \| 'removed' \| 'all'` | no | Defaults to `'active'` |

Before returning, this **triggers an opportunistic price refresh**
(`refreshStaleWatchlistPrices`) for any active item whose cached quote is
more than ~6 hours old - so calling this is also what keeps prices current;
nothing refreshes on a timer. Returns `WatchlistItem[]`, most recently added
first.

## Tools: portfolio

Holdings you actually own, tracked completely independently of the
watch-list, addressed by the natural **(ticker symbol, account)** pair
rather than by id - the same ticker can be a separate position in more than
one account (e.g. the same fund held in both an ISA and a pension), each
with its own quantity/cost/quote.

### `add_portfolio_holding`

Adds a holding, or - if this exact (symbol, account) pair already exists -
**overwrites** its quantity and average cost.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `symbol` | string | yes | |
| `name` | string | conditionally | Required the first time this symbol is ever referenced |
| `exchange` | string | no | |
| `account` | account enum | yes | Which account this position is held in |
| `quantity` | number > 0 | yes | Shares/units held |
| `averageCost` | number > 0 | yes | GBP, per share/unit |

Behavior notes: **this upsert always overwrites**, unlike
`add_watchlist_item` - re-adding a (symbol, account) pair means "this is now
the position," not "patch what changed." If a holding had been soft-removed,
re-adding it also reactivates it (`status` back to `'active'`). Use
`set_portfolio_holding` if you want to change just one field without
restating both.

Returns: `PortfolioHolding`.

### `set_portfolio_holding`

Partial update - only touches the field(s) you actually give it.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `symbol` | string | yes | |
| `account` | account enum | yes | |
| `quantity` | number > 0 | no | |
| `averageCost` | number > 0 | no | |

At least one of `quantity`/`averageCost` must be given (`isError: true` with
`Provide quantity and/or averageCost` if both are omitted). Returns the
updated `PortfolioHolding`, or errors with
`No portfolio holding for <symbol> in "<account>"` if that pair doesn't
exist.

### `remove_portfolio_holding`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `symbol` | string | yes | |
| `account` | account enum | yes | |

Soft delete for that specific (symbol, account) pair only - other accounts
holding the same ticker are untouched. To move a holding between accounts:
remove it here, then `add_portfolio_holding` it under the new account (this
is deliberate, not a missing feature - a holding's account is part of its
identity here, unlike the watch-list's account, which is just a label).

### `set_portfolio_manual_price`

Overrides the automatic (Yahoo Finance) price with a value you supply, for a
holding whose automatic quote is missing or unreliable. Added because Yahoo's
mutual-fund NAV coverage for some thinly-traded UK OEICs can silently freeze
on a years-old snapshot with no error at all - see
`database/init/009_add_portfolio_manual_price.sql` for the specific case
that prompted this (`GB00B1DSZS09`, frozen since 2019).

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `symbol` | string | yes | |
| `account` | account enum | yes | |
| `price` | number > 0, or `null` | yes | GBP per share/unit. **Pass `null` to clear the override and go back to automatic pricing** |

Behavior notes:
- While a manual price is set, it **takes priority over the automatic
  cached quote entirely** for this holding's `quote` field (market value and
  gain/loss on the dashboard are computed from it) - even if the automatic
  side also happens to have a value cached.
- The holding is **excluded from the automatic price refresh** for as long
  as the manual price is set (`stalePortfolioPriceSymbols` skips any row with
  `manual_price IS NOT NULL`) - so it will not silently get overwritten by a
  later automatic refresh, but it also will **not** update on its own once
  set. You're responsible for updating it again by hand.
- The returned quote has no meaningful day-change - `changePercent` is
  always `0` and `source` is `"manual"` (see [Data shapes](#data-shapes)).
  `asOf` reflects when the price was *set*, not a market timestamp.

Returns: the updated `PortfolioHolding`, with `quote.source === 'manual'`.
Errors with `No portfolio holding for <symbol> in "<account>"` if that pair
doesn't exist.

Example call (setting):
```json
{ "symbol": "GB00B1DSZS09", "account": "Steve ISA", "price": 32.22 }
```

Example call (clearing, back to automatic):
```json
{ "symbol": "GB00B1DSZS09", "account": "Steve ISA", "price": null }
```

### `list_portfolio`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `account` | account enum | no | Restrict to one account; omit for all accounts |
| `status` | `'active' \| 'removed' \| 'all'` | no | Defaults to `'active'` |

Same opportunistic-refresh behavior as `list_watchlist`: triggers
`refreshStalePortfolioPrices` for any active, non-manually-priced holding
whose cached quote is more than ~6 hours old, before returning. Returns
`PortfolioHolding[]`, most recently added first.

## Tools: calendar

### `add_calendar_event`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `date` | string `YYYY-MM-DD` | yes | |
| `title` | string | yes | |
| `description` | string | no | |
| `eventType` | `'earnings' \| 'dividend' \| 'macro' \| 'catalyst' \| 'other'` | no | Defaults to `'other'` |
| `ticker` | string | no | Must already be a known ticker symbol - see below |

Behavior note: unlike `create_article`'s ticker entries, this tool has no
`name` field to introduce a brand-new ticker with. If `ticker` doesn't
already exist in the system (from a prior `add_watchlist_item`,
`add_portfolio_holding`, or `create_article` call), the underlying
`upsertTicker` call throws
`Ticker "<SYMBOL>" doesn't exist yet - provide "name" to create it.` and the
whole call comes back `isError: true` with that message. Reference an
already-known ticker, or add it via one of those other tools first.

Returns: `CalendarEvent`.

### `list_upcoming_events`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `from` | string `YYYY-MM-DD` | no | Defaults to today |
| `to` | string `YYYY-MM-DD` | no | Defaults to 30 days from today |
| `ticker` | string | no | Filter to one ticker |

Returns: `CalendarEvent[]`, ascending by date. Despite the name, this is a
plain date-range filter, not specifically "future" events - passing a `from`
in the past returns past events too.

## REST ↔ MCP parity

Every MCP tool and every REST route call the *same* functions in
`src/db/queries.ts`, so behavior (upsert semantics, defaults, validation) is
identical either way - this table is just so you can find the REST
equivalent of an MCP tool, or vice versa, without re-reading `routes.ts`.

| MCP tool | REST equivalent |
|---|---|
| `create_article` | `POST /api/articles` (REST forces `source: 'manual'`) |
| `search_articles` | `GET /api/articles?q=...` |
| `get_article` | `GET /api/articles/:slug` |
| `add_watchlist_item` | `POST /api/watchlist` |
| `set_watchlist_account` | `PATCH /api/watchlist/:symbol/account` |
| `set_watchlist_buy_below` | `PATCH /api/watchlist/:symbol/buy-below` |
| `remove_watchlist_item` | `DELETE /api/watchlist/:symbol` |
| `list_watchlist` | `GET /api/watchlist` |
| `add_portfolio_holding` | `POST /api/portfolio` |
| `set_portfolio_holding` | `PATCH /api/portfolio/:symbol/:account` |
| `remove_portfolio_holding` | `DELETE /api/portfolio/:symbol/:account` |
| `set_portfolio_manual_price` | `PATCH /api/portfolio/:symbol/:account/manual-price` |
| `list_portfolio` | `GET /api/portfolio` |
| `add_calendar_event` | `POST /api/calendar` |
| `list_upcoming_events` | `GET /api/calendar` (REST doesn't default the range the same way - it returns everything if `from`/`to` are omitted, where this tool defaults to the next 30 days) |
| *(none - MCP-only)* | `GET /api/accounts`, `GET /api/tickers`, `GET /api/news`, `PATCH /api/news/:id/read`, and plain `GET /api/articles` (list/browse without a search query - `search_articles` requires a non-empty query, so there's no MCP equivalent for "just list recent articles") - no MCP tool wraps any of these yet |
