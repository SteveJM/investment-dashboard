import { Link } from 'react-router-dom';

/** Every ticker symbol in the app links through to its ticker detail page (articles/news/events that reference it). */
export function TickerLink({ symbol, name }: { symbol: string; name?: string }) {
  return (
    <Link to={`/tickers/${symbol}`} className="ticker-link" title={name}>
      {symbol}
    </Link>
  );
}
