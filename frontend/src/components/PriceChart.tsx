import { useMemo, useState } from 'react';
import {
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '../api/client';
import type { PriceHistoryPoint } from '../api/types';
import { AsyncSection } from './AsyncSection';
import { useAsync } from '../hooks/useAsync';
import { formatGBP } from '../util/format';

type Range = '1M' | '3M' | '6M';

const RANGE_DAYS: Record<Range, number> = { '1M': 30, '3M': 91, '6M': 182 };
const RANGE_LABELS: Record<Range, string> = { '1M': '1 month', '3M': '3 months', '6M': '6 months' };

interface ChartPoint {
  date: string; // x-axis category label, e.g. "12 Mar"
  timestamp: number; // for sorting/filtering
  close: number;
  sma20: number | null;
  sma50: number | null;
}

/**
 * Simple moving average over `closes`, aligned 1:1 with it - `closes[i]`'s
 * SMA is `null` until there are `period` points behind it (index >=
 * period - 1), same convention as any standard charting library. Computed
 * over the *full* fetched series (see buildChartPoints below), not just
 * the currently-visible range, so a short range like "1 month" still shows
 * a correct 50-day average from its very first visible day rather than
 * needing 50 days of run-up inside the visible window itself.
 */
function simpleMovingAverage(closes: number[], period: number): Array<number | null> {
  const result: Array<number | null> = new Array(closes.length).fill(null);
  let windowSum = 0;
  for (let i = 0; i < closes.length; i++) {
    windowSum += closes[i]!;
    if (i >= period) windowSum -= closes[i - period]!;
    if (i >= period - 1) result[i] = windowSum / period;
  }
  return result;
}

/**
 * The x-axis is a category scale keyed on this label (e.g. "12 Mar"), not
 * on the raw date - shared by `buildChartPoints` below and by the news
 * markers' date-matching in `PriceChart`, so a news item lands on the same
 * category as its matching price point only when both go through this same
 * formatter.
 */
function chartDateLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function buildChartPoints(history: PriceHistoryPoint[]): ChartPoint[] {
  // The API already returns these ascending by date, but don't trust that
  // blindly - a moving average computed on out-of-order input is silently
  // wrong, not an obvious crash.
  const sorted = [...history].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  const closes = sorted.map((p) => p.close);
  const sma20 = simpleMovingAverage(closes, 20);
  const sma50 = simpleMovingAverage(closes, 50);
  return sorted.map((p, i) => {
    const d = new Date(p.date);
    return {
      date: chartDateLabel(p.date),
      timestamp: d.getTime(),
      close: p.close,
      sma20: sma20[i] ?? null,
      sma50: sma50[i] ?? null,
    };
  });
}

// Fixed y-value news markers are plotted at, on their own hidden 0-1 axis
// (see the `yAxisId="markers"` YAxis below) - independent of the price
// scale, so markers always sit in the same spot near the bottom of the
// plot no matter what the visible price range is.
const NEWS_MARKER_Y = 0.06;

interface NewsMarkerShapeProps {
  cx?: number;
  cy?: number;
}

/** Small upward-pointing triangle, drawn by hand rather than relying on Scatter's preset `shape` strings so its exact size/position is predictable. */
function NewsMarkerShape({ cx, cy }: NewsMarkerShapeProps) {
  if (cx == null || cy == null) return null;
  return <path d={`M ${cx - 4} ${cy + 4} L ${cx + 4} ${cy + 4} L ${cx} ${cy - 4} Z`} fill="var(--text-muted)" />;
}

function ChartTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ dataKey?: string; name: string; value: number; color: string }>;
}) {
  // Whitelist the actual price series rather than blacklisting the news-
  // marker one - the `Scatter` series (see PriceChart below) was observed
  // to contribute not just its own "marker" entry but also a second one
  // keyed off the shared x-axis's own dataKey ("date", value e.g. "Jul 7"),
  // which this component would otherwise render as a nonsensical "date:
  // £Jul 7" line (formatGBP on a non-numeric value). A whitelist is safer
  // than chasing every stray key Scatter happens to add.
  const visible = payload?.filter((entry) => entry.dataKey === 'close' || entry.dataKey === 'sma20' || entry.dataKey === 'sma50');
  if (!active || !visible || visible.length === 0) return null;
  return (
    <div
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: '8px 10px',
        fontSize: 13,
      }}
    >
      {visible.map((entry) => (
        <div key={entry.name} style={{ color: entry.color }}>
          {entry.name}: {formatGBP(entry.value)}
        </div>
      ))}
    </div>
  );
}

/**
 * Interactive price chart for one ticker - 1/3/6-month range toggle plus
 * 20-/50-day moving-average overlays, the two "basic chart analysis"
 * features this was built for. Reads whatever's already in
 * `price_history` (via GET /api/tickers/:symbol/history); it never
 * triggers a fetch from the price provider itself - see
 * `service/src/cli/backfillHistory.ts` for how that table gets populated.
 *
 * `buyBelow`, if the ticker has one set on the watch-list, draws a dashed
 * horizontal reference line at that price - same green used elsewhere
 * (QuoteCell's "buy candidate" highlight) for "this is a target, not a
 * data series". `ifOverflow="extendDomain"` so the line is never silently
 * dropped just because the current price is well above/below it.
 *
 * `newsDates`, if given (raw ISO timestamps, e.g. from `NewsItem.publishedAt`
 * - see TickerPage), plots a small grey triangle along the bottom of the
 * chart for each visible date that has at least one news item. Markers use
 * their own hidden 0-1 y-axis (`yAxisId="markers"`) so they sit at a fixed
 * height regardless of the price scale, and only appear on dates that
 * already have a price point plotted (the x-axis is a category scale keyed
 * on the price series' own dates - see `chartDateLabel` - so a news date
 * with no matching trading day, e.g. a weekend, has no category to attach
 * to and is silently skipped rather than shown misaligned).
 */
export function PriceChart({
  symbol,
  buyBelow,
  newsDates = [],
}: {
  symbol: string;
  buyBelow?: number | null;
  newsDates?: string[];
}) {
  const history = useAsync(() => api.tickers.history(symbol), [symbol]);
  const [range, setRange] = useState<Range>('3M');
  const [showSma20, setShowSma20] = useState(true);
  const [showSma50, setShowSma50] = useState(true);

  const allPoints = useMemo(() => (history.data ? buildChartPoints(history.data) : []), [history.data]);

  const visiblePoints = useMemo(() => {
    if (allPoints.length === 0) return [];
    const lastTimestamp = allPoints[allPoints.length - 1]!.timestamp;
    const cutoff = lastTimestamp - RANGE_DAYS[range] * 24 * 60 * 60 * 1000;
    return allPoints.filter((p) => p.timestamp >= cutoff);
  }, [allPoints, range]);

  const newsDateLabels = useMemo(() => new Set(newsDates.map(chartDateLabel)), [newsDates]);

  // The news markers are rendered as a `Scatter` sharing this same array
  // (via the chart's top-level `data`, not a separate one passed to
  // `Scatter` itself) rather than a smaller array of just the news dates -
  // Recharts positions a category-axis series by looking up each row's
  // `date` against *this* array's order, and a Scatter given its own
  // shorter array was observed (visually, before this fix) to place points
  // by array index instead, bunching every marker at the chart's left edge
  // regardless of which dates actually had news. Non-news dates get
  // `marker: null` so nothing renders for them.
  const chartData = useMemo(
    () => visiblePoints.map((p) => ({ ...p, marker: newsDateLabels.has(p.date) ? NEWS_MARKER_Y : null })),
    [visiblePoints, newsDateLabels]
  );

  const changeOverRange = useMemo(() => {
    if (visiblePoints.length < 2) return null;
    const first = visiblePoints[0]!.close;
    const last = visiblePoints[visiblePoints.length - 1]!.close;
    return { absolute: last - first, percent: ((last - first) / first) * 100 };
  }, [visiblePoints]);

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 12 }}>
        <h3 style={{ margin: 0 }}>Price chart</h3>
        <div style={{ display: 'flex', gap: 6 }}>
          {(Object.keys(RANGE_DAYS) as Range[]).map((r) => (
            <button
              key={r}
              type="button"
              className={r === range ? undefined : 'secondary'}
              onClick={() => setRange(r)}
              title={RANGE_LABELS[r]}
              style={{ fontSize: 12, padding: '4px 10px' }}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      <AsyncSection
        data={history.data}
        loading={history.loading}
        error={history.error}
        isEmpty={(d) => d.length === 0}
        emptyMessage={`No price history yet for ${symbol}. Back-fill it from the service container: node dist/cli/backfillHistory.js --symbol=${symbol}`}
      >
        {() => (
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, margin: '4px 0 12px' }}>
              <div style={{ fontSize: 22, fontWeight: 600 }}>
                {visiblePoints.length > 0 ? formatGBP(visiblePoints[visiblePoints.length - 1]!.close) : '—'}
              </div>
              {changeOverRange && (
                <div className={changeOverRange.absolute >= 0 ? 'quote-up' : 'quote-down'} style={{ fontSize: 14 }}>
                  {changeOverRange.absolute >= 0 ? '+' : ''}
                  {formatGBP(changeOverRange.absolute)} ({changeOverRange.percent.toFixed(2)}%) over {RANGE_LABELS[range]}
                </div>
              )}
              <label className="muted" style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 4 }}>
                <input type="checkbox" checked={showSma20} onChange={(e) => setShowSma20(e.target.checked)} />
                20-day MA
              </label>
              <label className="muted" style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 4 }}>
                <input type="checkbox" checked={showSma50} onChange={(e) => setShowSma50(e.target.checked)} />
                50-day MA
              </label>
            </div>

            <ResponsiveContainer width="100%" height={320}>
              <ComposedChart data={chartData} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" stroke="var(--text-muted)" fontSize={12} tickMargin={8} minTickGap={24} />
                <YAxis
                  stroke="var(--text-muted)"
                  fontSize={12}
                  width={56}
                  domain={['auto', 'auto']}
                  tickFormatter={(v: number) => `£${v.toFixed(0)}`}
                />
                {/* Independent of the price axis above - purely so news markers plot at a fixed height near the bottom, whatever the price range is. */}
                <YAxis yAxisId="markers" domain={[0, 1]} hide />
                <Tooltip content={<ChartTooltip />} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="close" name="Close" stroke="var(--accent)" strokeWidth={2} dot={false} isAnimationActive={false} />
                {showSma20 && (
                  <Line
                    type="monotone"
                    dataKey="sma20"
                    name="20-day MA"
                    stroke="var(--medium)"
                    strokeWidth={1.5}
                    dot={false}
                    isAnimationActive={false}
                    connectNulls
                  />
                )}
                {showSma50 && (
                  <Line
                    type="monotone"
                    dataKey="sma50"
                    name="50-day MA"
                    stroke="var(--macro)"
                    strokeWidth={1.5}
                    dot={false}
                    isAnimationActive={false}
                    connectNulls
                  />
                )}
                {buyBelow != null && (
                  <ReferenceLine
                    y={buyBelow}
                    stroke="var(--high)"
                    strokeDasharray="6 4"
                    strokeWidth={1.5}
                    ifOverflow="extendDomain"
                    label={{
                      value: `Buy below ${formatGBP(buyBelow)}`,
                      position: 'insideBottomRight',
                      fill: 'var(--high)',
                      fontSize: 12,
                    }}
                  />
                )}
                <Scatter
                  yAxisId="markers"
                  dataKey="marker"
                  name="News"
                  shape={NewsMarkerShape}
                  legendType="triangle"
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </>
        )}
      </AsyncSection>
    </div>
  );
}
