/** Small display helpers shared by the feed components. */

/**
 * Screenshots are overwritten in place while the loop runs, so every <img> src
 * carries the current poll nonce — the browser would otherwise show the first
 * version it cached for the whole session.
 */
export function bust(src: string, nonce: number): string {
  return `${src}${src.includes("?") ? "&" : "?"}v=${nonce}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now" / "4 min ago" / "2 h ago". Absolute time goes in the tooltip. */
export function relativeTime(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const ago = Math.max(0, now - then);
  if (ago < MINUTE) return "just now";
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)} min ago`;
  if (ago < DAY) return `${Math.floor(ago / HOUR)} h ago`;
  return `${Math.floor(ago / DAY)} d ago`;
}

export function absoluteTime(iso: string): string {
  const then = Date.parse(iso);
  return Number.isNaN(then) ? iso : new Date(then).toLocaleString();
}

/** Local calendar day, used to break the stream into dated runs. */
export function dayKey(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  return new Date(then).toDateString();
}

/** "Today" / "Yesterday" / "Thursday 30 July" — the divider between runs. */
export function dayLabel(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const today = new Date(now).toDateString();
  const day = new Date(then);
  if (day.toDateString() === today) return "Today";
  const yesterday = new Date(now - DAY).toDateString();
  if (day.toDateString() === yesterday) return "Yesterday";
  return day.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}
