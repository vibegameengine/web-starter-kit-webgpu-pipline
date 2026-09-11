/**
 * The feed — the whole product.
 *
 * A fan-out of agents is opaque by construction: several file sets change at
 * once for minutes and everything the user hears arrives second-hand. Every
 * agent appends to the feed file itself, so this reads newest-first and the user
 * follows the work live instead of waiting for a summary.
 *
 * Comments are threaded, not interleaved. The file is one flat append-only
 * stream — the only thing that could be, with a dozen processes writing it — but
 * a comment carries the id of the post it answers, and the reading surface puts
 * it back where it belongs: under that post. A comment shown as its own card,
 * eleven entries above the thing it was about, makes the reader reconstruct the
 * connection every single time.
 */

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { POST_COMMAND } from "../config";
import { dayKey, dayLabel } from "../format";
import type { Post } from "../types";
import { Comment } from "./Comment";
import { FeedPost } from "./FeedPost";
import { ReplyBox } from "./ReplyBox";

interface Props {
  posts: Post[] | null;
  error: string | null;
  now: number;
  nonce: number;
  /** Names seen in the feed, for `@` completion inside the reply box. */
  authors: string[];
  onPosted: () => void;
}

export function Feed({ posts, error, now, nonce, authors, onPosted }: Props): ReactNode {
  // Which post's reply box is open. Purely local: nothing above the feed needs
  // to know, and at most one is open at a time.
  const [replyFor, setReplyFor] = useState<string | null>(null);
  const close = useCallback(() => setReplyFor(null), []);

  const { roots, threads, acks } = useMemo(() => {
    const all = posts ?? [];
    const byId = new Map(all.map((p) => [p.id, p]));
    const threads = new Map<string, Post[]>();
    const acks = new Map<string, Post[]>();
    const roots: Post[] = [];

    const push = (map: Map<string, Post[]>, key: string, value: Post) => {
      const list = map.get(key);
      if (list) list.push(value);
      else map.set(key, [value]);
    };

    for (const entry of all) {
      // A receipt is never an entry in its own right — it belongs to the thing
      // it acknowledges. One pointing at something no longer in the file is
      // dropped rather than shown loose, where it would read as a bare emoji
      // from nobody about nothing.
      if (entry.kind === "ack") {
        if (entry.re && byId.has(entry.re)) push(acks, entry.re, entry);
        continue;
      }
      // A comment answering a post we still have goes into that post's thread.
      // One answering a post that has scrolled out of the file — or answering
      // nothing at all, which is what a broadcast is — stands on its own.
      if (entry.kind === "comment" && entry.re && byId.has(entry.re)) {
        push(threads, entry.re, entry);
      } else {
        roots.push(entry);
      }
    }
    // The feed reads newest-first; a thread and its receipts read oldest-first,
    // like a conversation. `all` is already newest-first, so both are reversed.
    for (const thread of threads.values()) thread.reverse();
    for (const list of acks.values()) list.reverse();
    return { roots, threads, acks };
  }, [posts]);

  if (!posts) {
    return (
      <p className="empty">{error ? `feed.jsonl unavailable — ${error}` : "Reading the feed…"}</p>
    );
  }
  if (posts.length === 0) {
    return <p className="empty">Nothing posted yet. Agents write here with {POST_COMMAND}.</p>;
  }

  let day = "";
  return (
    <div className="feed" data-testid="feed-list">
      {roots.map((entry) => {
        const key = dayKey(entry.at);
        const opensDay = key !== day;
        day = key;
        const thread = threads.get(entry.id) ?? [];
        const open = replyFor === entry.id;

        return (
          <div className="feed-run" key={entry.id}>
            {opensDay ? <h2 className="day">{dayLabel(entry.at, now)}</h2> : null}

            {entry.kind === "comment" ? (
              // A broadcast, or a reply whose post is no longer in the file.
              <Comment comment={entry} now={now} acks={acks.get(entry.id) ?? []} />
            ) : (
              <FeedPost
                post={entry}
                now={now}
                nonce={nonce}
                acks={acks.get(entry.id) ?? []}
                onReply={(id) => setReplyFor((cur) => (cur === id ? null : id))}
                replying={open}
              />
            )}

            {thread.length > 0 || open ? (
              <div className="thread" data-testid={`feed-thread-${entry.id}`}>
                {thread.map((comment) => (
                  <Comment
                    key={comment.id}
                    comment={comment}
                    now={now}
                    acks={acks.get(comment.id) ?? []}
                  />
                ))}
                {open ? (
                  <ReplyBox authors={authors} parent={entry} onDone={close} onPosted={onPosted} />
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
      <p className="feed-end">That is everything posted so far.</p>
    </div>
  );
}
