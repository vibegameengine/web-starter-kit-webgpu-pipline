/**
 * The registry behind the left rail.
 *
 * `agents.json` is a projection: `presence.mjs` rebuilds it from the per-agent
 * files on every tool call, so the browser fetches one small file and never has
 * to list a directory - which it could not do without a server, and this design
 * deliberately has none.
 */

import { usePolling, type Polled } from "./usePolling";

export type Agent = {
  id: string;
  name: string;
  goal: string;
  cwd?: string;
  status?: string;
  tool?: string | null;
  calls?: number;
  registeredAt?: string;
  lastSeen?: string;
};

export const AGENTS_URL = "/tmp/dashboard/agents.json";

/**
 * A missing registry does not answer 404. Vite falls back to `index.html` with
 * a 200, so `res.ok` is true and `JSON.parse` throws on a `<`. That would put
 * an error in the rail where the truth is "nobody has registered yet" - which
 * is the normal state of a fresh session and not a fault.
 */
function readAgents(body: string): Agent[] {
  if (body.trimStart().startsWith("<")) return [];
  try {
    const parsed = JSON.parse(body) as { agents?: Agent[] };
    return Array.isArray(parsed.agents) ? parsed.agents : [];
  } catch {
    // Rebuilt on every tool call by a different process; a read can land
    // mid-write. One stale frame is better than an error card.
    return [];
  }
}

export function useAgents(nonce: number): Polled<Agent[]> {
  return usePolling(AGENTS_URL, readAgents, nonce);
}

/** Minutes since a timestamp, or null when it is missing or unparseable. */
export function minutesSince(iso: string | undefined, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((now - t) / 60000));
}

/**
 * Three states, and the middle one is why this exists. A session that stops
 * does not announce it - it simply stops making tool calls, and the row would
 * otherwise sit there looking busy forever.
 */
export function liveness(iso: string | undefined, now: number): "live" | "idle" | "gone" {
  const m = minutesSince(iso, now);
  if (m === null) return "gone";
  if (m < 3) return "live";
  if (m < 30) return "idle";
  return "gone";
}


