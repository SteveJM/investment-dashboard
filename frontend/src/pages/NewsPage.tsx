import { api } from '../api/client';
import { AsyncSection } from '../components/AsyncSection';
import { TickerLink } from '../components/TickerLink';
import { useAsync } from '../hooks/useAsync';
import { useNewsReadTracking } from '../hooks/useNewsReadTracking';
import { formatDateTime } from '../util/format';

export function NewsPage() {
  const news = useAsync(() => api.news.list(), []);
  const { isRead, markRead } = useNewsReadTracking();

  return (
    <>
      <div className="page-header">
        <div>
          <h2>News</h2>
          <p>Recent headlines for everything on your watch-list.</p>
        </div>
      </div>

      <div className="card">
        <AsyncSection {...news} isEmpty={(d) => d.length === 0} emptyMessage="No news yet - add tickers to your watch-list to start seeing headlines.">
          {(items) => (
            <table>
              <tbody>
                {items.map((n) => (
                  <tr key={n.id} className={isRead(n) ? 'news-read' : undefined}>
                    <td style={{ width: 90 }}>
                      <TickerLink symbol={n.ticker.symbol} name={n.ticker.name} />
                    </td>
                    <td>
                      {n.url ? (
                        <a href={n.url} target="_blank" rel="noreferrer" onClick={() => markRead(n.id)}>
                          {n.headline}
                        </a>
                      ) : (
                        n.headline
                      )}
                      {n.summary && <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>{n.summary}</div>}
                    </td>
                    <td className="muted" style={{ width: 170, whiteSpace: 'nowrap' }}>
                      {n.source && <div>{n.source}</div>}
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
