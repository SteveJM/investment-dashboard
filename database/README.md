# database

Postgres 16 image with the Investment Dashboard schema baked in.

## What's here

- `init/001_schema.sql` - tables: `tickers`, `articles`, `article_tickers`,
  `watchlist_items`, `calendar_events`, `news_items`.
- `init/002_seed.sql` - a small example article/watch-list/calendar entry so
  the dashboard isn't empty on first boot. Delete this file (or edit it) if
  you don't want sample data.
- `init/003_add_watchlist_account.sql` - adds `watchlist_items.account`
  (`ISA` / `Taxable` / `Pension`, nullable). Applied automatically
  on a fresh volume; for an already-running deployment, apply it by hand (see
  below).
- `init/004_add_watchlist_buy_below.sql` - adds `watchlist_items.buy_below`
  (numeric, nullable) - a target price you set yourself to flag candidate
  purchases. Applied automatically on a fresh volume; for an already-running
  deployment, apply it by hand (see below).
- `init/005_add_watchlist_price.sql` - adds `watchlist_items.latest_price` /
  `latest_price_change_percent` / `latest_price_currency` / `price_updated_at`
  - a quote refreshed opportunistically from the price provider. Applied
  automatically on a fresh volume; for an already-running deployment, apply it
  by hand (see below).
- `init/006_add_news_read_status.sql` - adds `news_items.is_read` (boolean,
  defaults false) - set once the frontend records a headline's link as
  clicked. Applied automatically on a fresh volume; for an already-running
  deployment, apply it by hand (see below).
- `init/007_relax_watchlist_account_constraint.sql` - drops the CHECK
  constraint added in `003_add_watchlist_account.sql`. Account names are now
  configurable via the `ACCOUNTS` env var (see `service/src/config.ts`)
  rather than hard-coded, so validation moved to the application layer.
  Applied automatically on a fresh volume; for an already-running deployment,
  apply it by hand (see below).

## How migrations run

The official `postgres` image executes every `.sql`/`.sh` file in
`/docker-entrypoint-initdb.d/`, in filename order, but **only the first time
a container starts against an empty `PGDATA` directory**. This means:

- Fresh volume + this image -> schema + seed data applied automatically.
- Existing volume -> init scripts are skipped entirely, even after a
  `docker build`/image update. Add new files numbered after the existing
  ones (e.g. `003_add_x.sql`) and apply them by hand for existing
  deployments (`psql -f database/init/003_add_x.sql`), or drop the volume in
  dev.

## Local build/run (standalone, outside compose)

```bash
docker build -t investment-dashboard-db ./database
docker run -d \
  --name investment-dashboard-db \
  -e POSTGRES_PASSWORD=devpassword \
  -p 5432:5432 \
  -v investment-dashboard-db-data:/var/lib/postgresql/data \
  investment-dashboard-db
```

Normally you'll run this via the root `docker-compose.yml` instead, which
wires in the connection details the `service` container expects.
