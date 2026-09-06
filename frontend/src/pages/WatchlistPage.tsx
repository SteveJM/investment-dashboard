import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { Account, WatchlistItem } from '../api/types';
import { api, ApiError } from '../api/client';
import { AsyncSection } from '../components/AsyncSection';
import { ArticleLink } from '../components/ArticleLink';
import { AccountBadge, ConvictionBadge, QuoteCell } from '../components/Badges';
import { TickerLink } from '../components/TickerLink';
import { useAsync } from '../hooks/useAsync';
import { formatDate } from '../util/format';

// Matches the service's own staleness window (services/priceRefresh.ts) -
// polling faster than that would just re-request quotes the server hasn't
// refreshed yet.
const PRICE_POLL_MS = 60 * 1000;

/**
 * Inline-editable "buy below" price for one row. Kept as its own component
 * so each row has independent draft/saving state without the parent having
 * to track a map keyed by symbol.
 */
function BuyBelowCell({
  item,
  onSaved,
}: {
  item: WatchlistItem;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(item.buyBelow != null ? String(item.buyBelow) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  async function save() {
    const trimmed = draft.trim();
    const parsed = trimmed === '' ? null : Number(trimmed);
    if (parsed !== null && (!Number.isFinite(parsed) || parsed <= 0)) {
      setError('Must be a positive number');
      setDraft(item.buyBelow != null ? String(item.buyBelow) : '');
      return;
    }
    if (parsed === (item.buyBelow ?? null)) return; // unchanged - skip the round-trip
    setError(undefined);
    setSaving(true);
    try {
      await api.watchlist.setBuyBelow(item.ticker.symbol, parsed);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setDraft(item.buyBelow != null ? String(item.buyBelow) : '');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="currency-input-wrap">
        <span className="currency-prefix">£</span>
        <input
          type="number"
          min="0.01"
          step="0.01"
          placeholder="Unset"
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

export function WatchlistPage() {
  const watchlist = useAsync(() => api.watchlist.list('active'), []);
  const accounts = useAsync(() => api.accounts.list(), []);
  const accountOptions = accounts.data ?? [];
  const [formError, setFormError] = useState<string>();
  const [symbol, setSymbol] = useState('');
  const [name, setName] = useState('');
  const [account, setAccount] = useState<Account | ''>('');
  const [buyBelow, setBuyBelow] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [removingSymbol, setRemovingSymbol] = useState<string>();
  const [removeError, setRemoveError] = useState<string>();
  const [updatingAccountSymbol, setUpdatingAccountSymbol] = useState<string>();
  const [accountError, setAccountError] = useState<string>();
  const [accountFilter, setAccountFilter] = useState<Account | 'all' | 'unassigned'>('all');
  const [buyCandidatesOnly, setBuyCandidatesOnly] = useState(false);

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    setFormError(undefined);
    setSubmitting(true);
    try {
      await api.watchlist.add({
        symbol: symbol.trim().toUpperCase(),
        name: name.trim() || undefined,
        account: account || undefined,
        buyBelow: buyBelow.trim() ? Number(buyBelow) : undefined,
      });
      setSymbol('');
      setName('');
      setAccount('');
      setBuyBelow('');
      watchlist.reload();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRemove(symbolToRemove: string) {
    setRemoveError(undefined);
    setRemovingSymbol(symbolToRemove);
    try {
      await api.watchlist.remove(symbolToRemove);
      watchlist.reload();
    } catch (err) {
      setRemoveError(`Couldn't remove ${symbolToRemove}: ${err instanceof ApiError ? err.message : String(err)}`);
    } finally {
      setRemovingSymbol(undefined);
    }
  }

  async function handleAccountChange(symbolToUpdate: string, newAccount: Account | '') {
    setAccountError(undefined);
    setUpdatingAccountSymbol(symbolToUpdate);
    try {
      await api.watchlist.setAccount(symbolToUpdate, newAccount || null);
      watchlist.reload();
    } catch (err) {
      setAccountError(`Couldn't update ${symbolToUpdate}'s account: ${err instanceof ApiError ? err.message : String(err)}`);
    } finally {
      setUpdatingAccountSymbol(undefined);
    }
  }

  useEffect(() => {
    const interval = setInterval(watchlist.reload, PRICE_POLL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filteredItems = useMemo(() => {
    if (!watchlist.data) return undefined;
    let items = watchlist.data;
    if (accountFilter === 'unassigned') items = items.filter((w) => !w.account);
    else if (accountFilter !== 'all') items = items.filter((w) => w.account === accountFilter);
    if (buyCandidatesOnly) items = items.filter((w) => w.buyBelow != null);
    return items;
  }, [watchlist.data, accountFilter, buyCandidatesOnly]);

  return (
    <>
      <div className="page-header">
        <div>
          <h2>Watch-list</h2>
          <p>Tickers surfaced by research articles, plus anything you've added manually.</p>
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
          style={{ width: 260 }}
        />
        <select value={account} onChange={(e) => setAccount(e.target.value as Account | '')}>
          <option value="">No account</option>
          {accountOptions.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <div className="currency-input-wrap">
          <span className="currency-prefix">£</span>
          <input
            type="number"
            min="0.01"
            step="0.01"
            placeholder="Buy below (optional)"
            className="buy-below-input"
            value={buyBelow}
            onChange={(e) => setBuyBelow(e.target.value)}
            style={{ width: 150 }}
          />
        </div>
        <button type="submit" disabled={submitting}>
          Add to watch-list
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
            <option value="unassigned">Unassigned</option>
          </select>
        </label>
        <label className="muted" style={{ fontSize: 13 }}>
          <input
            type="checkbox"
            checked={buyCandidatesOnly}
            onChange={(e) => setBuyCandidatesOnly(e.target.checked)}
            style={{ marginRight: 6 }}
          />
          Has a buy-below price set
        </label>
      </form>

      {removeError && <p className="error-state">{removeError}</p>}
      {accountError && <p className="error-state">{accountError}</p>}

      <div className="card">
        <AsyncSection
          data={filteredItems}
          loading={watchlist.loading}
          error={watchlist.error}
          isEmpty={(d) => d.length === 0}
          emptyMessage={accountFilter === 'all' && !buyCandidatesOnly ? 'Watch-list is empty.' : 'No watch-list items match this filter.'}
        >
          {(items) => (
            <table>
              <thead>
                <tr>
                  <th>Ticker</th>
                  <th>Latest price</th>
                  <th>Conviction</th>
                  <th>Account</th>
                  <th>Buy below</th>
                  <th>Notes</th>
                  <th>Source</th>
                  <th>Added</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((w) => (
                  <tr key={w.id}>
                    <td>
                      <TickerLink symbol={w.ticker.symbol} name={w.ticker.name} />
                      <div className="muted" style={{ fontSize: 12 }}>
                        {w.ticker.name}
                      </div>
                    </td>
                    <td style={{ width: 100 }}>
                      <QuoteCell quote={w.quote} buyBelow={w.buyBelow} />
                    </td>
                    <td>
                      <ConvictionBadge conviction={w.conviction} />
                    </td>
                    <td>
                      <div style={{ marginBottom: 4 }}>
                        <AccountBadge account={w.account} />
                      </div>
                      <select
                        className="account-select"
                        value={w.account ?? ''}
                        disabled={updatingAccountSymbol === w.ticker.symbol}
                        onChange={(e) => handleAccountChange(w.ticker.symbol, e.target.value as Account | '')}
                      >
                        <option value="">Unassigned</option>
                        {accountOptions.map((a) => (
                          <option key={a} value={a}>
                            {a}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td style={{ width: 130 }}>
                      <BuyBelowCell item={w} onSaved={watchlist.reload} />
                    </td>
                    <td className="muted">{w.notes ?? '—'}</td>
                    <td>
                      <ArticleLink article={w.sourceArticle} />
                    </td>
                    <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                      {formatDate(w.addedAt)}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="secondary"
                        disabled={removingSymbol === w.ticker.symbol}
                        onClick={() => handleRemove(w.ticker.symbol)}
                      >
                        {removingSymbol === w.ticker.symbol ? 'Removing…' : 'Remove'}
                      </button>
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
