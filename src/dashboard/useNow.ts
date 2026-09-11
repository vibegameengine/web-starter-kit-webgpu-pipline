/**
 * A clock that ticks on the poll cadence, so the feed's "4 min ago" labels age
 * on their own. Shared by every post rather than read per-render, so they all
 * agree on what "now" is.
 */

import { useEffect, useState } from "react";
import { POLL_MS } from "./usePolling";

export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), POLL_MS);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}
