import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { Account, PortfolioHolding } from '../api/types';
import { api, ApiError } from '../api/client';
import { AsyncSection } from '../components/AsyncSection';
import { AccountBadge, QuoteCell } from '../components/Badges';
import { TickerLink } from '../components/TickerLink';
import { useAsync } from '../hooks/useAsync';
import { formatGBP, formatQuotePrice } from '../util/format';

// Matches the service's own staleness window (services/priceRefresh.ts) -
// polling faster than that would just re-request quotes the server hasn't
// refreshed yet.
const PRICE_POLL_MS = 60 * 1000;

/**
 * Market value, cost basis and gain/loss for one holding. Market value uses
 * the quote's own price (whatever currency the ticker trades in); cost
 * basis uses averageCost, which - like the watch-list's "buy below" - is
 * always GBP (a value set by the user). Comparing the two ignores any
 * currency mismatch for a foreign-listed ticker, the same simplification
 * the watch-list's buy-below-candidate check already makes.
 */
function computeGainLoss(holding: PortfolioHolding) {
  const costBasis = holding.quantity * holding.averageCost;
  const marketValue = holding.quote ? holding.quantity * holding.quote.price : null;
  const gainLoss = marketValue !== null ? marketValue - costBasis : null;
  const gainLossPercent = gainLoss !== null && costBasis > 0 ? (gainLoss / costBasis) * 100 : null;
  return { costBasis, marketValue, gainLoss, gainLossPercent };
}

/**
 * Formats a gain/loss + percentage pair, treating them as a single unit -
 * either both are shown or neither is ("—"). Deliberately doesn't trust a
 * non-null `gainLoss` to imply a non-null `gainLossPercent` (an empty
 * portfolio's totals are the case that doesn't hold: gainLoss = 0 - 0 = 0,
 * but gainLossPercent is null since there's no cost basis to divide by) -
 * that mismatch is what crashed the page before this was fixed to check
 * both values explicitly rather than asserting one implies the other.
 */
function formatGainLoss(gainLoss: number | null, gainLossPercent: number | null): string {
  if (gainLoss === null || gainLossPercent === null) return '—';
  return `${gainLoss >= 0 ? '+' : ''}${formatGBP(gainLoss)} (${gainLossPercent.toFixed(2)}%)`;
}

/**
 * Inline-editable quantity/average-cost cell for one row. Kept as its own
 * component so each row has independent draft/saving state, same reasoning
 * as WatchlistPage's BuyBelowCell.
 */
function EditableNumberCell({
  value,
  prefix,
  onSave,
}: {
  value: number;
  prefix?: string;
  onSave: (value: number) => Promise<void>;
}) {
  const [draft, setDraft] = useState(String(value));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  async function save() {
    const trimmed = draft.trim();
    const parsed = Number(trimmed);
    if (trimmed === '' || !Number.isFinite(parsed) || parsed <= 0) {
      setError('Must be a positive number');
      setDraft(String(value));
      return;
    }
    if (parsed === value) return; // unchanged - skip the round-trip
    setError(undefined);
    setSaving(true);
    try {
      await onSave(parsed);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setDraft(String(value));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className={prefix ? 'currency-input-wrap' : undefined}>
        {prefix && <span className="currency-prefix">{prefix}</span>}
        <input
          type="number"
          min="0.000001"
          step="any"
          className="buy-below-input"
          value={draft}
          disabled={saving}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
      </div>
      {error && <div className="error-state" style={{ fontSize: 12, padding: '2px 0 0' }}>{error}</div>}
    </div>
  );
}

/**
 * Wraps the Latest Price cell with a manual-override control, for a holding
 * whose automatic price provider (Yahoo Finance) has no reliable live quote
 * - e.g. GB00B1DSZS09 (Liontrust UK Listed Smaller Companies, formerly
 * branded River & Mercantile) returns a Yahoo quote frozen on a 2019
 * snapshot, so the automatic refresh just kept re-caching a badly wrong,
 * ~7-year-stale price with no error at all. Setting a price here takes over
 * display entirely and the service skips this holding in its automatic
 * refresh (see setPortfolioManualPrice) until it's cleared back to
 * automatic.
 */
function ManualPriceCell({ holding, onChanged }: { holding: PortfolioHolding; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const isManual = holding.quote?.source === 'manual';

  async function save() {
    const parsed = Number(draft.trim());
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError('Must be a positive number');
      return;
    }
    setError(undefined);
    setBusy(true);
    try {
      await api.portfolio.setManualPrice(holding.ticker.symbol, holding.account, parsed);
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function clearOverride() {
    setError(undefined);
    setBusy(true);
    try {
      await api.portfolio.setManualPrice(holding.ticker.symbol, holding.account, null);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <div>
        <div className="currency-input-wrap">
          <span className="currency-prefix">£</span>
          <input
            type="number"
            min="0.0001"
            step="any"
            autoFocus
            className="buy-below-input"
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') setEditing(false);
            }}
          />
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 3 }}>
          <button type="button" className="secondary" disabled={busy} onClick={save} style={{ fontSize: 12, padding: '2px 6px' }}>
            Save
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => setEditing(false)}
            style={{ fontSize: 12, padding: '2px 6px' }}
          >
            Cancel
          </button>
        </div>
        {error && <div className="error-state" style={{ fontSize: 12 }}>{error}</div>}
      </div>
    );
  }

  return (
    <div>
      <QuoteCell quote={holding.quote} />
      <button
        type="button"
        className="secondary"
        disabled={busy}
        onClick={
          isManual
            ? clearOverride
            : () => {
                setDraft(holding.quote ? String(holding.quote.price) : '');
                setEditing(true);
              }
        }
        style={{ fontSize: 11, padding: '2px 6px', marginTop: 3 }}
      >
        {busy ? 'Working…' : isManual ? 'Use automatic price' : 'Set manually'}
      </button>
      {error && <div className="error-state" style={{ fontSize: 12 }}>{error}</div>}
    </div>
  );
}

export function PortfolioPage() {
  const portfolio = useAsync(() => api.portfolio.list({ status: 'active' }), []);
  const accounts = useAsync(() => api.accounts.list(), []);
  const accountOptions = accounts.data ?? [];
  const [formError, setFormError] = useState<string>();
  const [symbol, setSymbol] = useState('');
  const [name, setName] = useState('');
  const [account, setAccount] = useState<Account | ''>('');
  const [quantity, setQuantity] = useState('');
  const [averageCost, setAverageCost] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [removingKey, setRemovingKey] = useState<string>();
  const [removeError, setRemoveError] = useState<string>();
  const [accountFilter, setAccountFilter] = useState<Account | 'all'>('all');

  useEffect(() => {
    // Default the add-form's account to the first configured one once the
    // list loads, so the (required) select isn't left showing a blank option.
    if (!account && accountOptions.length > 0) setAccount(accountOptions[0]!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountOptions.length]);

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    setFormError(undefined);
    if (!account) {
      setFormError('Choose an account');
      return;
    }
    const parsedQuantity = Number(quantity);
    const parsedAverageCost = Number(averageCost);
    if (!Number.isFinite(parsedQuantity) || parsedQuantity <= 0) {
      setFormError('Quantity must be a positive number');
      return;
    }
    if (!Number.isFinite(parsedAverageCost) || parsedAverageCost <= 0) {
      setFormError('Average cost must be a positive number');
      return;
    }
    setSubmitting(true);
    try {
      await api.portfolio.add({
        symbol: symbol.trim().toUpperCase(),
        name: name.trim() || undefined,
        account,
        quantity: parsedQuantity,
        averageCost: parsedAverageCost,
      });
      setSymbol('');
      setName('');
      setQuantity('');
      setAverageCost('');
      portfolio.reload();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRemove(h: PortfolioHolding) {
    const key = `${h.ticker.symbol}:${h.account}`;
    setRemoveError(undefined);
    setRemovingKey(key);
    try {
      await api.portfolio.remove(h.ticker.symbol, h.account);
      portfolio.reload();
    } catch (err) {
      setRemoveError(`Couldn't remove ${h.ticker.symbol} (${h.account}): ${err instanceof ApiError ? err.message : String(err)}`);
    } finally {
      setRemovingKey(undefined);
    }
  }

  useEffect(() => {
    const interval = setInterval(portfolio.reload, PRICE_POLL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filteredItems = useMemo(() => {
    if (!portfolio.data) return undefined;
    if (accountFilter === 'all') return portfolio.data;
    return portfolio.data.filter((h) => h.account === accountFilter);
  }, [portfolio.data, accountFilter]);

  const totals = useMemo(() => {
    if (!filteredItems) return null;
    let costBasis = 0;
    let marketValue = 0;
    let hasAllQuotes = true;
    for (const h of filteredItems) {
      const g = computeGainLoss(h);
      costBasis += g.costBasis;
      if (g.marketValue !== null) marketValue += g.marketValue;
      else hasAllQuotes = false;
    }
    // Cost basis is 0 when there are no holdings (the empty-portfolio case) -
    // there's nothing to compute a gain/loss against, so both values need to
    // stay null together here rather than gainLoss coming out as a stray 0.
    const gainLoss = hasAllQuotes && costBasis > 0 ? marketValue - costBasis : null;
    const gainLossPercent = gainLoss !== null ? (gainLoss / costBasis) * 100 : null;
    return { costBasis, marketValue: hasAllQuotes ? marketValue : null, gainLoss, gainLossPercent };
  }, [filteredItems]);

  return (
    <>
      <div className="page-header">
        <div>
          <h2>Portfolio</h2>
          <p>Holdings you actually own - independent of the watch-list.</p>
        </div>
      </div>

      <form className="inline-form" onSubmit={handleAdd}>
        <input
          type="text"
          placeholder="Symbol (e.g. TSLA)"
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          required
          style={{ width: 120 }}
        />
        <input
          type="text"
          placeholder="Company name (only needed for a new ticker)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ width: 240 }}
        />
        <select value={account} onChange={(e) => setAccount(e.target.value as Account)} required>
          {accountOptions.length === 0 && <option value="">Loading accounts…</option>}
          {accountOptions.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <input
          type="number"
          min="0.000001"
          step="any"
          placeholder="Quantity"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          style={{ width: 110 }}
          required
        />
        <div className="currency-input-wrap">
          <span className="currency-prefix">£</span>
          <input
            type="number"
            min="0.01"
            step="0.01"
            placeholder="Avg cost"
            className="buy-below-input"
            value={averageCost}
            onChange={(e) => setAverageCost(e.target.value)}
            required
          />
        </div>
        <button type="submit" disabled={submitting}>
          Add holding
        </button>
        {formError && <span className="error-state">{formError}</span>}
      </form>

      <form className="inline-form" onSubmit={(e) => e.preventDefault()}>
        <label className="muted" style={{ fontSize: 13 }}>
          Filter by account{' '}
          <select value={accountFilter} onChange={(e) => setAccountFilter(e.target.value as typeof accountFilter)}>
            <option value="all">All</option>
            {accountOptions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
      </form>

      {removeError && <p className="error-state">{removeError}</p>}

      {totals && (
        <div className="card">
          <h3>Summary{accountFilter !== 'all' ? ` — ${accountFilter}` : ''}</h3>
          <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
            <div>
              <div className="muted" style={{ fontSize: 12 }}>
                Cost basis
              </div>
              <div style={{ fontSize: 18, fontWeight: 600 }}>{formatGBP(totals.costBasis)}</div>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 12 }}>
                Market value
              </div>
              <div style={{ fontSize: 18, fontWeight: 600 }}>{totals.marketValue !== null ? formatGBP(totals.marketValue) : '—'}</div>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 12 }}>
                Gain / loss
              </div>
              <div
                style={{ fontSize: 18, fontWeight: 600 }}
                className={totals.gainLoss === null ? undefined : totals.gainLoss >= 0 ? 'quote-up' : 'quote-down'}
              >
                {formatGainLoss(totals.gainLoss, totals.gainLossPercent)}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <AsyncSection
          data={filteredItems}
          loading={portfolio.loading}
          error={portfolio.error}
          isEmpty={(d) => d.length === 0}
          emptyMessage={accountFilter === 'all' ? 'Portfolio is empty.' : 'No holdings in this account.'}
        >
          {(items) => (
            <table>
              <thead>
                <tr>
                  <th>Ticker</th>
                  <th>Account</th>
                  <th>Quantity</th>
                  <th>Avg cost</th>
                  <th>Latest price</th>
                  <th>Market value</th>
                  <th>Gain / loss</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((h) => {
                  const key = `${h.ticker.symbol}:${h.account}`;
                  const g = computeGainLoss(h);
                  return (
                    <tr key={h.id}>
                      <td>
                        <TickerLink symbol={h.ticker.symbol} name={h.ticker.name} />
                        <div className="muted" style={{ fontSize: 12 }}>
                          {h.ticker.name}
                        </div>
                      </td>
                      <td>
                        <AccountBadge account={h.account} />
                      </td>
                      <td style={{ width: 110 }}>
                        <EditableNumberCell
                          value={h.quantity}
                          onSave={async (v) => {
                            await api.portfolio.update(h.ticker.symbol, h.account, { quantity: v });
                            portfolio.reload();
                          }}
                        />
                      </td>
                      <td style={{ width: 130 }}>
                        <EditableNumberCell
                          value={h.averageCost}
                          prefix="£"
                          onSave={async (v) => {
                            await api.portfolio.update(h.ticker.symbol, h.account, { averageCost: v });
                            portfolio.reload();
                          }}
                        />
                      </td>
                      <td style={{ width: 140 }}>
                        <ManualPriceCell holding={h} onChanged={portfolio.reload} />
                      </td>
                      <td className="quote-price">{g.marketValue !== null ? formatQuotePrice(g.marketValue, h.quote?.currency ?? 'GBP') : '—'}</td>
                      <td className={g.gainLoss === null ? 'muted' : g.gainLoss >= 0 ? 'quote-up' : 'quote-down'}>
                        {formatGainLoss(g.gainLoss, g.gainLossPercent)}
                      </td>
                      <td>
                        <button type="button" className="secondary" disabled={removingKey === key} onClick={() => handleRemove(h)}>
                          {removingKey === key ? 'Removing…' : 'Remove'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </AsyncSection>
      </div>
    </>
  );
}
