/**
 * Poll a file served by the dev server from the project root and parse it.
 *
 * The feed grows while agents work, so the page re-reads it on a fixed cadence
 * and on demand (the reload button bumps `nonce`). The URL is cache-busted for
 * the same reason the screenshots are: the files change under the browser.
 */

import { useEffect, useState } from "react";

/** Backup for non-Vite hosts. Vite pushes changes instantly through HMR below. */
export const POLL_MS = 30_000;

export interface Polled<T> {
  data: T | null;
  error: string | null;
}

export function usePolling<T>(url: string, parse: (body: string) => T, nonce: number): Polled<T> {
  const [state, setState] = useState<Polled<T>>({ data: null, error: null });

  useEffect(() => {
    let live = true;

    const read = async (): Promise<void> => {
      try {
        const res = await fetch(`${url}?v=${Date.now()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const parsed = parse(await res.text());
        if (live) setState({ data: parsed, error: null });
      } catch (err) {
        if (live) setState((prev) => ({ data: prev.data, error: String(err) }));
      }
    };

    void read();
    const timer = window.setInterval(() => void read(), POLL_MS);
    const onFeedUpdate = (): void => { void read(); };
    import.meta.hot?.on("agent-work-feed:update", onFeedUpdate);
    return () => {
      live = false;
      window.clearInterval(timer);
      import.meta.hot?.off("agent-work-feed:update", onFeedUpdate);
    };
    // `parse` is a module-level function in every caller, so it is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, nonce]);

  return state;
}
