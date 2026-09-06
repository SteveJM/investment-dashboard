import { useCallback, useState } from 'react';
import { api } from '../api/client';

/**
 * Tracks which news items have been marked read this session, optimistically
 * ahead of the PATCH actually confirming - so the pale "read" styling applies
 * the instant a headline is clicked rather than waiting on a round-trip or a
 * full reload. Best-effort: if the PATCH fails, the item still reads as read
 * locally for the rest of this session, and simply reverts on next reload.
 */
export function useNewsReadTracking() {
  const [locallyRead, setLocallyRead] = useState<Set<string>>(new Set());

  const markRead = useCallback((id: string) => {
    setLocallyRead((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    api.news.markRead(id).catch(() => {
      // best-effort - see doc comment above.
    });
  }, []);

  const isRead = useCallback((item: { id: string; isRead: boolean }) => item.isRead || locallyRead.has(item.id), [locallyRead]);

  return { isRead, markRead };
}
