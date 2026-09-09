import { useState } from 'react';
import { api, ApiError } from '../api/client';
import { AsyncSection } from './AsyncSection';
import { useAsync } from '../hooks/useAsync';
import { formatDateTime } from '../util/format';

/**
 * On-demand LLM summary of a ticker's recent news - see
 * `service/README.md`'s "News summary" section for the Gemini
 * `generateContent` request this drives server-side. Reads whatever's
 * already stored on mount (persists across page reloads); "Generate News
 * Summary" is a real API call with real latency (and, for the real
 * provider, real cost), so it's never triggered automatically.
 */
export function NewsSummaryCard({ symbol }: { symbol: string }) {
  const summary = useAsync(() => api.tickers.newsSummary(symbol), [symbol]);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string>();

  async function generate() {
    setGenerating(true);
    setGenerateError(undefined);
    try {
      await api.tickers.generateNewsSummary(symbol);
      summary.reload();
    } catch (err) {
      setGenerateError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 12 }}>
        <h3 style={{ margin: 0 }}>News summary</h3>
        <button type="button" className="secondary" onClick={generate} disabled={generating} style={{ fontSize: 12, padding: '4px 10px' }}>
          {generating ? 'Generating…' : summary.data ? 'Regenerate' : 'Generate News Summary'}
        </button>
      </div>

      {generateError && (
        <p className="error-state" style={{ fontSize: 13, margin: '8px 0 0' }}>
          Couldn't generate a summary: {generateError}
        </p>
      )}

      <AsyncSection
        data={summary.data}
        loading={summary.loading}
        error={summary.error}
        isEmpty={(d) => d === null}
        emptyMessage={`No summary yet for ${symbol}. Click "Generate News Summary" above to summarize its recent news.`}
      >
        {(data) => {
          if (!data) return null; // isEmpty already filters this out - just satisfying the type checker
          return (
            <>
              <p style={{ whiteSpace: 'pre-wrap', margin: '10px 0 6px' }}>{data.summary}</p>
              <p className="muted" style={{ fontSize: 12 }}>Generated {formatDateTime(data.createdAt)}</p>
            </>
          );
        }}
      </AsyncSection>
    </div>
  );
}
