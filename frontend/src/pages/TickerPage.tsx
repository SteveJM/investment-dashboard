import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { AsyncSection } from '../components/AsyncSection';
import { ConvictionBadge, EventTypeBadge } from '../components/Badges';
import { NewsSummaryCard } from '../components/NewsSummaryCard';
import { PriceChart } from '../components/PriceChart';
import { useAsync } from '../hooks/useAsync';
import { useNewsReadTracking } from '../hooks/useNewsReadTracking';
import { formatDate, formatDateTime } from '../util/format';

export function TickerPage() {
  const { symbol = '' } = useParams();

  const watchlist = useAsync(() => api.watchlist.list('all'), []);
  const articles = useAsync(() => api.articles.list({ ticker: symbol }), [symbol]);
  const events = useAsync(() => api.calendar.list({ ticker: symbol }), [symbol]);
  const news = useAsync(() => api.news.list({ ticker: symbol }), [symbol]);
  const { isRead, markRead } = useNewsReadTracking();

  const watchlistEntry = watchlist.data?.find((w) => w.ticker.symbol === symbol);

  return (
    <>
      <p className="breadcrumb">
        <Link to="/">← Dashboard</Link>
      </p>
      <div className="page-header">
        <div>
          <h2>{symbol}</h2>
          {watchlistEntry && <p>{watchlistEntry.ticker.name}{watchlistEntry.ticker.exchange ? ` · ${watchlistEntry.ticker.exchange}` : ''}</p>}
        </div>
        {watchlistEntry && watchlistEntry.status === 'active' && <ConvictionBadge conviction={watchlistEntry.conviction} />}
      </div>

      <PriceChart symbol={symbol} buyBelow={watchlistEntry?.buyBelow ?? null} newsDates={news.data?.map((n) => n.publishedAt) ?? []} />

      <div className="card">
        <h3>Articles referencing {symbol}</h3>
        <AsyncSection {...articles} isEmpty={(d) => d.length === 0} emptyMessage="No articles reference this ticker yet.">
          {(items) => (
            <table>
              <tbody>
                {items.map((a) => (
                  <tr key={a.id}>
                    <td className="muted" style={{ width: 120, whiteSpace: 'nowrap' }}>
                      {formatDate(a.publishedAt)}
                    </td>
                    <td>
                      <Link to={`/articles/${a.slug}`}>{a.title}</Link>
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

      <div className="card">
        <h3>Calendar events</h3>
        <AsyncSection {...events} isEmpty={(d) => d.length === 0} emptyMessage="No calendar events for this ticker.">
          {(items) => (
            <table>
              <tbody>
                {items.map((e) => (
                  <tr key={e.id}>
                    <td className="muted" style={{ width: 120, whiteSpace: 'nowrap' }}>
                      {formatDate(e.date)}
                    </td>
                    <td style={{ width: 100 }}>
                      <EventTypeBadge eventType={e.eventType} />
                    </td>
                    <td>{e.title}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </AsyncSection>
      </div>

      <NewsSummaryCard symbol={symbol} />

      <div className="card">
        <h3>News</h3>
        <AsyncSection {...news} isEmpty={(d) => d.length === 0} emptyMessage="No news for this ticker yet.">
          {(items) => (
            <table>
              <tbody>
                {items.map((n) => (
                  <tr key={n.id} className={isRead(n) ? 'news-read' : undefined}>
                    <td>
                      {n.url ? (
                        <a href={n.url} target="_blank" rel="noreferrer" onClick={() => markRead(n.id)}>
                          {n.headline}
                        </a>
                      ) : (
                        n.headline
                      )}
                    </td>
                    <td className="muted" style={{ width: 170, whiteSpace: 'nowrap' }}>
                      {formatDateTime(n.publishedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </AsyncSection>
      </div>
    </>
  );
}
