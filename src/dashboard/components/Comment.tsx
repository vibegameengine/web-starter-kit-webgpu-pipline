/**
 * A human's comment, rendered under the post it answers.
 *
 * Not a card in the timeline. A comment is not an event that happened at a time
 * — it is a remark about a particular post, and reading it apart from that post
 * costs the reader the work of reconstructing what it was about. So it sits in
 * the thread beneath its parent, smaller and quieter than the post, with the
 * addressee stated because that is the one thing a reader cannot infer.
 */

import { memo, type ReactNode } from "react";
import { absoluteTime, relativeTime } from "../format";
import type { Post } from "../types";
import { Acks } from "./Acks";
import { PostBody } from "./PostBody";

interface Props {
  comment: Post;
  /** Passed in rather than read from the clock so everything ages together. */
  now: number;
  /** Receipts from the agents this reached — the answer to "did anyone hear me". */
  acks: Post[];
}

function CommentImpl({ comment, now, acks }: Props): ReactNode {
  const to = comment.to ?? [];
  const broadcast = to.length === 0 || to.includes("all");

  return (
    <article className="comment" data-testid={`feed-comment-${comment.id}`}>
      <div className="comment-head">
        <span className="comment-author">{comment.author}</span>
        {/* Written from a command line, which in this repo means an agent — not
            the human, whatever name is on it. Shown because an agent relaying
            an instruction reads exactly like the person who gave it, and the
            reader has to be able to tell an order from a paraphrase. */}
        {comment.via !== "ui" ? (
          <span className="comment-via" data-testid={`feed-comment-via-${comment.id}`}>
            agent
          </span>
        ) : null}
        <time className="comment-time" dateTime={comment.at} title={absoluteTime(comment.at)}>
          {relativeTime(comment.at, now)}
        </time>
        {/* Who has to act. Never behind a hover: a comment whose addressee you
            cannot see is a comment every agent might take as an order. */}
        <span
          className={`tag-to${broadcast ? " is-all" : ""}`}
          data-testid={`feed-comment-to-${comment.id}`}
        >
          → {broadcast ? "everyone" : to.map((name) => `@${name}`).join(" ")}
        </span>
      </div>
      <PostBody text={comment.text} />
      <Acks acks={acks} now={now} />
    </article>
  );
}

export const Comment = memo(CommentImpl);
