# frontend

React + Vite + TypeScript SPA for the Investment Dashboard.

## Pages

- **Dashboard** (`/`) - upcoming calendar events (30 days), watch-list summary, latest research.
- **Calendar** (`/calendar`) - full list of notable dates, filterable by date range and ticker.
- **Watch-list** (`/watchlist`) - active watch-list with conviction/notes/source article, manual add/remove.
- **News** (`/news`) - recent headlines for everything on the watch-list.
- **Article** (`/articles/:slug`) - a single research article (markdown body rendered).
- **Ticker** (`/tickers/:symbol`) - everything referencing one ticker: articles, calendar events, news.

Every ticker symbol shown anywhere links to its `/tickers/:symbol` page; every
calendar/watch-list entry links back to the article that produced it.

## Running locally (without Docker)

```bash
cp .env.example .env.local   # points the dev server at a local `service` on :4000
npm install
npm run dev
```

This talks directly to the service's REST API (`http://localhost:4000`) with
the API key in `.env.local` - fine for local dev, since the key already
lives on your machine. Make sure `service`'s `CORS_ORIGINS` includes
`http://localhost:5173` (it does by default).

## Production build (what the Docker image runs)

```bash
npm run build   # outputs static assets to dist/
```

For this build, leave `VITE_API_BASE_URL`/`VITE_API_KEY` **unset**. The app
then calls the API as same-origin relative paths (`/api/...`), and nginx (see
`Dockerfile` + `nginx/default.conf.template`) proxies those to the `service`
container and injects `Authorization: Bearer $API_KEY` itself - the key never
ends up in the browser bundle.

## Known/accepted issue

`react-router-dom` has an open moderate advisory (GHSA-wrjc-x8rr-h8h6, open
redirect via a backslash in `<Link>`/`useNavigate`) that's only fixed in the
v7 line as of this writing; upgrading is a breaking change this project
hasn't taken yet. Low real-world risk for a single-user, auth-gated internal
dashboard - revisit if this is ever exposed more broadly. Run `npm audit` to
recheck.
