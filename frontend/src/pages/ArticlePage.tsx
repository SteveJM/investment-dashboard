import { marked } from 'marked';
import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { AsyncSection } from '../components/AsyncSection';
import { ConvictionBadge } from '../components/Badges';
import { TickerLink } from '../components/TickerLink';
import { useAsync } from '../hooks/useAsync';
import { formatDateTime } from '../util/format';

export function ArticlePage() {
  const { slug = '' } = useParams();
  const article = useAsync(() => api.articles.get(slug), [slug]);

  const bodyHtml = useMemo(() => {
    if (!article.data) return '';
    return marked.parse(article.data.body, { async: false }) as string;
  }, [article.data]);

  return (
    <AsyncSection {...article} emptyMessage="Article not found.">
      {(a) => (
        <>
          <p className="breadcrumb">
            <Link to="/">← Dashboard</Link>
          </p>
          <div className="page-header">
            <div>
              <h2>{a.title}</h2>
              <p>
                {formatDateTime(a.publishedAt)} · {a.source === 'mcp' ? 'via MCP' : 'manual entry'}
              </p>
            </div>
            <ConvictionBadge conviction={a.conviction} />
          </div>

          {a.tickers.length > 0 && (
            <div className="pill-row" style={{ marginBottom: 20 }}>
              {a.tickers.map((t) => (
                <span key={t.symbol} className="card" style={{ padding: '6px 12px', margin: 0 }}>
                  <TickerLink symbol={t.symbol} name={t.name} />
                  {t.context && <span className="muted"> — {t.context}</span>}
                </span>
              ))}
            </div>
          )}

          <div className="card">
            <div className="article-body" dangerouslySetInnerHTML={{ __html: bodyHtml }} />
          </div>
        </>
      )}
    </AsyncSection>
  );
}
