import { useState } from 'react';
import { api } from '../api/client';
import { AsyncSection } from '../components/AsyncSection';
import { EventTypeBadge } from '../components/Badges';
import { TickerLink } from '../components/TickerLink';
import { ArticleLink } from '../components/ArticleLink';
import { useAsync } from '../hooks/useAsync';
import { formatDate } from '../util/format';
import type { CalendarEvent } from '../api/types';

function groupByDate(events: CalendarEvent[]): [string, CalendarEvent[]][] {
  const map = new Map<string, CalendarEvent[]>();
  for (const e of events) {
    const list = map.get(e.date) ?? [];
    list.push(e);
    map.set(e.date, list);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export function CalendarPage() {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  const [ticker, setTicker] = useState('');

  const events = useAsync(() => api.calendar.list({ from, to, ticker: ticker || undefined }), [from, to, ticker]);

  return (
    <>
      <div className="page-header">
        <div>
          <h2>Calendar</h2>
          <p>Notable dates flagged by research articles - earnings, dividends, macro releases, catalysts.</p>
        </div>
      </div>

      <form className="inline-form" onSubmit={(e) => e.preventDefault()}>
        <label className="muted" style={{ fontSize: 13 }}>
          From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="muted" style={{ fontSize: 13 }}>
          To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label className="muted" style={{ fontSize: 13 }}>
          Ticker{' '}
          <input
            type="text"
            placeholder="e.g. AAPL"
            value={ticker}
            onChange={(e) => setTicker(e.target.value.toUpperCase())}
            style={{ width: 90 }}
          />
        </label>
      </form>

      <div className="card">
        <AsyncSection {...events} isEmpty={(d) => d.length === 0} emptyMessage="No events in this range.">
          {(items) => (
            <>
              {groupByDate(items).map(([date, dayEvents]) => (
                <div key={date} style={{ marginBottom: 16 }}>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>{formatDate(date)}</div>
                  <table>
                    <tbody>
                      {dayEvents.map((e) => (
                        <tr key={e.id}>
                          <td style={{ width: 110 }}>
                            <EventTypeBadge eventType={e.eventType} />
                          </td>
                          <td style={{ width: 90 }}>
                            {e.ticker ? <TickerLink symbol={e.ticker.symbol} name={e.ticker.name} /> : <span className="muted">—</span>}
                          </td>
                          <td>
                            <div>{e.title}</div>
                            {e.description && <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>{e.description}</div>}
                            <div style={{ marginTop: 4 }}>
                              <ArticleLink article={e.sourceArticle} />
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </>
          )}
        </AsyncSection>
      </div>
    </>
  );
}
