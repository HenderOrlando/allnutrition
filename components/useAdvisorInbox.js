'use client';
import { useCallback, useEffect, useState } from 'react';

const empty = { data: null, unreadCount: 0, availability: 'loading', loading: true, error: '', offline: false };

export default function useAdvisorInbox(api, { sessionKey, showList, revision }) {
  const [page, setPage] = useState(1);
  const [generation, setGeneration] = useState(0);
  const [snapshot, setSnapshot] = useState(null);
  const reload = useCallback(() => setGeneration(value => value + 1), []);

  useEffect(() => {
    let active = true, request;
    const current = state => state?.sessionKey === sessionKey ? state : empty;
    const update = change => setSnapshot(state => ({ ...current(state), ...change, sessionKey }));

    async function read() {
      if (document.visibilityState !== 'visible') return;
      request?.abort();
      if (!navigator.onLine) {
        update({ offline: true, loading: false, error: '' });
        return;
      }
      request = new AbortController();
      const { signal } = request;
      update({ loading: true, offline: false, error: '' });
      try {
        const settings = await api('/api/admin/assistant/settings', { signal });
        if (!active || signal.aborted) return;
        if (!settings.enabled || settings.connectionStatus !== 'ready') {
          update({ data: null, unreadCount: 0, availability: 'disabled', loading: false });
          return;
        }
        const query = showList ? `page=${page}` : 'summary=1';
        const data = await api(`/api/admin/assistant/inbox?${query}`, { signal });
        if (!active || signal.aborted) return;
        update({ ...(showList ? { data } : null), unreadCount: data.unreadCount, availability: 'ready', loading: false });
      } catch (error) {
        if (!active || signal.aborted) return;
        update({ availability: 'error', loading: false, error: error.message || 'No se pudieron consultar tus avisos.', offline: !navigator.onLine });
      }
    }
    const visibility = () => {
      if (document.visibilityState === 'visible') void read();
      else request?.abort();
    };
    void read();
    const timer = window.setInterval(read, 60000);
    document.addEventListener('visibilitychange', visibility);
    for (const event of ['focus', 'online', 'offline']) window.addEventListener(event, read);
    return () => {
      active = false;
      request?.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', visibility);
      for (const event of ['focus', 'online', 'offline']) window.removeEventListener(event, read);
    };
  }, [api, sessionKey, showList, page, revision, generation]);

  const state = snapshot?.sessionKey === sessionKey ? snapshot : empty;
  return { ...state, data: state.data?.page === page ? state.data : null, page, setPage, reload };
}
