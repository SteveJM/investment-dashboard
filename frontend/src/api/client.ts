import type { Account, Article, ArticleSummary, CalendarEvent, NewsItem, Ticker, WatchlistItem } from './types';

// In the production/Docker build these are unset, so requests go to
// same-origin relative paths (e.g. `/api/tickers`) and nginx proxies them
// to the service container, injecting the Authorization header there - the
// API key never reaches the browser bundle. In local `npm run dev`, set
// both in `.env.local` (copy from `.env.example`) to talk directly to a
// locally-running service.
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';
const API_KEY = import.meta.env.VITE_API_KEY;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    // Only declare a JSON body when we're actually sending one - Fastify's
    // default JSON parser rejects a request whose Content-Type claims
    // application/json but whose body is empty (e.g. our DELETE calls),
    // returning 400 before it ever reaches the route handler.
    ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`;

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // response body wasn't JSON - fall back to statusText
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function qs(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][];
  if (entries.length === 0) return '';
  return `?${new URLSearchParams(entries).toString()}`;
}

export const api = {
  tickers: {
    list: () => request<Ticker[]>('/api/tickers'),
  },
  accounts: {
    list: () => request<Account[]>('/api/accounts'),
  },
  watchlist: {
    list: (status: 'active' | 'removed' | 'all' = 'active') =>
      request<WatchlistItem[]>(`/api/watchlist${qs({ status })}`),
    add: (input: {
      symbol: string;
      name?: string;
      exchange?: string;
      conviction?: string;
      notes?: string;
      account?: Account;
      buyBelow?: number;
    }) => request<WatchlistItem>('/api/watchlist', { method: 'POST', body: JSON.stringify(input) }),
    setAccount: (symbol: string, account: Account | null) =>
      request<WatchlistItem>(`/api/watchlist/${symbol}/account`, { method: 'PATCH', body: JSON.stringify({ account }) }),
    setBuyBelow: (symbol: string, buyBelow: number | null) =>
      request<WatchlistItem>(`/api/watchlist/${symbol}/buy-below`, { method: 'PATCH', body: JSON.stringify({ buyBelow }) }),
    remove: (symbol: string) => request<WatchlistItem>(`/api/watchlist/${symbol}`, { method: 'DELETE' }),
  },
  calendar: {
    list: (params: { from?: string; to?: string; ticker?: string } = {}) =>
      request<CalendarEvent[]>(`/api/calendar${qs(params)}`),
  },
  articles: {
    list: (params: { ticker?: string; q?: string } = {}) => request<ArticleSummary[]>(`/api/articles${qs(params)}`),
    get: (slug: string) => request<Article>(`/api/articles/${slug}`),
  },
  news: {
    list: (params: { ticker?: string } = {}) => request<NewsItem[]>(`/api/news${qs(params)}`),
    markRead: (id: string) => request<NewsItem>(`/api/news/${id}/read`, { method: 'PATCH' }),
  },
};
