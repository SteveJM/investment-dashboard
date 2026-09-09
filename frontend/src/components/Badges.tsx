import type { Account, CalendarEventType, Conviction, WatchlistQuote } from '../api/types';
import { formatChangePercent, formatQuotePrice } from '../util/format';

export function ConvictionBadge({ conviction }: { conviction: Conviction | null }) {
  if (!conviction) return <span className="muted">—</span>;
  return <span className={`badge badge-${conviction}`}>{conviction}</span>;
}

export function EventTypeBadge({ eventType }: { eventType: CalendarEventType }) {
  return <span className={`badge badge-${eventType}`}>{eventType}</span>;
}

// Account names are configurable (ACCOUNTS env var - see service/README.md),
// so there's no way to pre-declare a CSS class/color per account like the
// other badge kinds do. Instead, pick a color deterministically from a small
// palette by hashing the account name, so a given account always renders in
// the same color across reloads without any per-deployment CSS.
const ACCOUNT_PALETTE = [
  [91, 140, 255], // blue
  [255, 159, 107], // orange
  [107, 214, 209], // teal
  [185, 139, 255], // purple
  [245, 196, 81], // yellow
  [62, 207, 142], // green
  [255, 107, 107], // red
] as const;

function accountColor(account: string): readonly [number, number, number] {
  let hash = 0;
  for (let i = 0; i < account.length; i++) {
    hash = (Math.imul(hash, 31) + account.charCodeAt(i)) | 0;
  }
  return ACCOUNT_PALETTE[Math.abs(hash) % ACCOUNT_PALETTE.length] ?? ACCOUNT_PALETTE[0];
}

export function AccountBadge({ account }: { account: Account | null }) {
  if (!account) return <span className="muted">—</span>;
  const [r, g, b] = accountColor(account);
  return (
    <span className="badge" style={{ background: `rgba(${r}, ${g}, ${b}, 0.15)`, color: `rgb(${r}, ${g}, ${b})` }}>
      {account}
    </span>
  );
}

/**
 * Renders a watch-list item's cached quote (see `services/priceRefresh.ts`
 * on the service side - it's refreshed opportunistically whenever the
 * watch-list is read, not pushed in real time). `buyBelow`, if given, flags
 * the price green as a candidate purchase when it's at or below that target.
 */
export function QuoteCell({ quote, buyBelow }: { quote: WatchlistQuote | null; buyBelow?: number | null }) {
  if (!quote) return <span className="muted">—</span>;
  const isCandidate = buyBelow != null && quote.price <= buyBelow;
  const changeClass = quote.changePercent > 0 ? 'quote-up' : quote.changePercent < 0 ? 'quote-down' : 'muted';
  return (
    <div>
      <div className={isCandidate ? 'quote-price quote-buy-candidate' : 'quote-price'} title={isCandidate ? 'At or below your buy-below target' : undefined}>
        {formatQuotePrice(quote.price, quote.currency)}
      </div>
      {quote.source === 'manual' ? (
        // A manual price has no day-change to show (see setPortfolioManualPrice) -
        // show when it was set instead, so it reads as "not live" rather than frozen.
        <div className="muted" style={{ fontSize: 12 }} title="Set by hand, not from the automatic price provider">
          manual · {new Date(quote.asOf).toLocaleDateString()}
        </div>
      ) : (
        <div className={changeClass} style={{ fontSize: 12 }}>
          {formatChangePercent(quote.changePercent)}
        </div>
      )}
    </div>
  );
}
