/**
 * The receipts under a comment: who has seen it, and what they said they would
 * do about it.
 *
 * This is the smallest thing on the page and close to the most important. The
 * human writes an instruction and then looks at a feed that has not changed;
 * until an agent posts its result — minutes later — the screen is
 * indistinguishable from one where the message reached nobody, the hook is
 * broken, or every agent is dead. A row of chips that appears within seconds is
 * the difference between "they are on it" and "kill the run".
 *
 * So it is rendered inline and immediately, never behind a hover or a count.
 */

import { memo, type ReactNode } from "react";
import { absoluteTime, relativeTime } from "../format";
import type { Post } from "../types";

interface Props {
  acks: Post[];
  /** Passed in rather than read from the clock so everything ages together. */
  now: number;
}

function AcksImpl({ acks, now }: Props): ReactNode {
  if (acks.length === 0) return null;
  return (
    <ul className="acks" data-testid="feed-acks">
      {acks.map((ack) => (
        <li key={ack.id}>
          <span
            className="ack"
            data-testid={`feed-ack-${ack.id}`}
            data-author={ack.author}
            title={`${ack.author} · ${absoluteTime(ack.at)}`}
          >
            <span className="ack-emoji" aria-hidden="true">
              {ack.emoji}
            </span>
            <span className="ack-author">{ack.author}</span>
            {ack.text ? <span className="ack-text">{ack.text}</span> : null}
            <time className="ack-time" dateTime={ack.at}>
              {relativeTime(ack.at, now)}
            </time>
          </span>
        </li>
      ))}
    </ul>
  );
}

export const Acks = memo(AcksImpl);
