/** The append-only stream every agent posts to. Its URL is `FEED_URL` in `config.ts`. */

import { FEED_URL } from "./config";
import { toFeed } from "./parse";
import type { Post } from "./types";
import { usePolling, type Polled } from "./usePolling";

/**
 * A missing feed does not answer 404. Vite falls back to `index.html` with a
 * 200, so `res.ok` is true, every line fails to parse, and the page settles on
 * "Nothing posted yet" beside a green live dot — the one answer that is wrong in
 * both halves: nobody has posted, and nobody can, because the page is reading a
 * file that is not there.
 *
 * Caught here rather than in `parse.ts`, whose contract is to survive a
 * half-written trailing line without throwing. This is not a damaged line; it is
 * the wrong document.
 */
function readFeed(body: string): Post[] {
  if (body.trimStart().startsWith("<")) {
    throw new Error(
      `${FEED_URL} returned HTML, not the feed — the file does not exist yet, or ` +
        `FEED_URL does not name the same file as FEED in scripts/post.mjs.`,
    );
  }
  return toFeed(body);
}

export function useFeed(nonce: number): Polled<Post[]> {
  return usePolling(FEED_URL, readFeed, nonce);
}
