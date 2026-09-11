/**
 * The one piece of chrome: a translucent bar that floats over the column.
 *
 * It carries only what the feed cannot say itself — that the page is still
 * reading the file, how much is in it, and a way to re-read it now.
 */

import type { ReactNode } from "react";
import { BRAND } from "../config";
import { POLL_MS } from "../usePolling";

interface Props {
  count: number;
  /** Set while the last read of feed.jsonl failed. */
  error: string | null;
  onReload: () => void;
  /**
   * Open the one comment box that is not attached to a post — a message to
   * every agent at once. It lives up here rather than above the stream because
   * it is a rare, deliberate act; a box that sits over the feed permanently
   * turns a page you read into a form you fill.
   */
  onBroadcast: () => void;
  broadcasting: boolean;
}

export function Header({ count, error, onReload, onBroadcast, broadcasting }: Props): ReactNode {
  return (
    <header className="chrome">
      <div className="chrome-inner">
        <span className="chrome-brand">{BRAND}</span>
        <span
          className={error ? "status status-off" : "status"}
          title={`feed.jsonl is re-read every ${Math.round(POLL_MS / 1000)} seconds`}
        >
          <i className="status-dot" aria-hidden="true" />
          {error ? "not reading feed.jsonl" : `live · ${count} ${count === 1 ? "post" : "posts"}`}
        </span>
        <button
          type="button"
          className="btn"
          data-testid="feed-broadcast-open"
          data-open={broadcasting}
          onClick={onBroadcast}
        >
          {broadcasting ? "Close" : "Everyone"}
        </button>
        <button type="button" className="btn" data-testid="feed-reload" onClick={onReload}>
          Refresh
        </button>
      </div>
    </header>
  );
}
