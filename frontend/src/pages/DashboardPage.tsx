import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { AsyncSection } from '../components/AsyncSection';
import { AccountBadge, ConvictionBadge, EventTypeBadge, QuoteCell } from '../components/Badges';
import { TickerLink } from '../components/TickerLink';
import { useAsync } from '../hooks/useAsync';
import { formatDate, formatGBP } from '../util/format';

// Matches the service's own staleness window (services/priceRefresh.ts).
const PRICE_POLL_MS = 60 * 1000;

export function DashboardPage() {
  const today = new Date().toISOString().slice(0, 10);
  const in30Days = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const events = useAsync(() => api.calendar.list({ from: today, to: in30Days }), []);
  const watchlist = useAsync(() => api.watchlist.list('active'), []);
  const articles = useAsync(() => api.articles.list(), []);

  useEffect(() => {
    const interval = setInterval(watchlist.reload, PRICE_POLL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <div className="page-header">
        <div>
          <h2>Dashboard</h2>
          <p>Upcoming dates, your watch-list, and the latest research at a glance.</p>
        </div>
      </div>

      <div className="grid-2">
        <div>
          <div className="card">
            <h3>Upcoming dates (next 30 days)</h3>
            <AsyncSection {...events} isEmpty={(d) => d.length === 0} emptyMessage="No notable dates in the next 30 days.">
              {(items) => (
                <table>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Event</th>
                      <th>Type</th>
                      <th>Ticker</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((e) => (
                      <tr key={e.id}>
                        <td>{formatDate(e.date)}</td>
                        <td>{e.title}</td>
                        <td>
                          <EventTypeBadge eventType={e.eventType} />
                        </td>
                        <td>{e.ticker ? <TickerLink symbol={e.ticker.symbol} name={e.ticker.name} /> : <span className="muted">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </AsyncSection>
            <p className="breadcrumb" style={{ marginTop: 12 }}>
              <Link to="/calendar">View full calendar →</Link>
            </p>
          </div>

          <div className="card">
            <h3>Latest research</h3>
            <AsyncSection {...articles} isEmpty={(d) => d.length === 0} emptyMessage="No articles published yet.">
              {(items) => (
                <table>
                  <tbody>
                    {items.slice(0, 8).map((a) => (
                      <tr key={a.id}>
                        <td style={{ width: '30%', whiteSpace: 'nowrap' }} className="muted">
                          {formatDate(a.publishedAt)}
                        </td>
                        <td>
                          <Link to={`/articles/${a.slug}`}>{a.title}</Link>
                          <div className="pill-row" style={{ marginTop: 4 }}>
                            {a.tickers.map((t) => (
                              <TickerLink key={t.symbol} symbol={t.symbol} name={t.name} />
                            ))}
                          </div>
                        </td>
                        <td style={{ width: 90 }}>
                          <ConvictionBadge conviction={a.conviction} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </AsyncSection>
          </div>
        </div>

        <div>
          <div className="card">
            <h3>Watch-list</h3>
            <AsyncSection {...watchlist} isEmpty={(d) => d.length === 0} emptyMessage="Watch-list is empty.">
              {(items) => (
                <table>
                  <tbody>
                    {items.map((w) => (
                      <tr key={w.id}>
                        <td>
                          <TickerLink symbol={w.ticker.symbol} name={w.ticker.name} />
                          <div className="muted" style={{ fontSize: 12 }}>
                            {w.ticker.name}
                          </div>
                        </td>
                        <td style={{ width: 90 }}>
                          <QuoteCell quote={w.quote} buyBelow={w.buyBelow} />
                        </td>
                        <td style={{ width: 90 }}>
                          <ConvictionBadge conviction={w.conviction} />
                        </td>
                        <td style={{ width: 120 }}>
                          <AccountBadge account={w.account} />
                        </td>
                        <td style={{ width: 90 }} className={w.buyBelow != null ? undefined : 'muted'}>
                          {w.buyBelow != null ? `≤ ${formatGBP(w.buyBelow)}` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </AsyncSection>
            <p className="breadcrumb" style={{ marginTop: 12 }}>
              <Link to="/watchlist">Manage watch-list →</Link>
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
