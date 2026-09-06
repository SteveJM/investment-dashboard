import type { ReactNode } from 'react';

/** Wraps a data-driven section with consistent loading/error/empty handling. */
export function AsyncSection<T>({
  loading,
  error,
  data,
  isEmpty,
  emptyMessage = 'Nothing here yet.',
  children,
}: {
  loading: boolean;
  error: string | undefined;
  data: T | undefined;
  isEmpty?: (data: T) => boolean;
  emptyMessage?: string;
  children: (data: T) => ReactNode;
}) {
  if (loading && data === undefined) return <p className="empty-state">Loading…</p>;
  if (error) return <p className="error-state">Couldn't load this: {error}</p>;
  if (data === undefined) return null;
  if (isEmpty?.(data)) return <p className="empty-state">{emptyMessage}</p>;
  return <>{children(data)}</>;
}
