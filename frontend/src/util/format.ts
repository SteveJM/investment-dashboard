export function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** No currency symbol - tickers here can be on any exchange/currency. */
export function formatPrice(value: number): string {
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** "Buy below" targets are always GBP (a value the user sets themselves), unlike quotes which carry their own currency. */
export function formatGBP(value: number): string {
  return `£${formatPrice(value)}`;
}

/** A quote's price, formatted with its own currency's symbol (falls back to the plain number if the currency code is unrecognized). */
export function formatQuotePrice(price: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(price);
  } catch {
    return formatPrice(price);
  }
}

export function formatChangePercent(changePercent: number): string {
  const sign = changePercent > 0 ? '+' : '';
  return `${sign}${changePercent.toFixed(2)}%`;
}
