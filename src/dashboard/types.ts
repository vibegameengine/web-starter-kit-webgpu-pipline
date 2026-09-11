/**
 * The one file the dashboard reads — `FEED_URL` in `config.ts`.
 *
 * It is appended to by several processes at once while a pass runs, so nothing
 * here may be assumed valid — see `parse.ts`, the only place this shape is
 * constructed.
 */

/**
 * `note`/`done`/`problem` are written by agents, about their work. `comment` is
 * written by the human, at the agents — the same stream in the other direction,
 * so one file holds the whole conversation in one order. `ack` is an agent
 * saying it received a comment, posted before it starts work: without it the
 * human writes into a screen that does not change, and cannot tell a running
 * agent from a dead one.
 */
export type PostKind = "note" | "done" | "problem" | "comment" | "ack";

export interface Post {
  id: string;
  /** ISO timestamp. */
  at: string;
  author: string;
  kind: PostKind;
  /** Capped at ~250 characters by the poster, so every post is a few lines. */
  text: string;
  /** Root-relative screenshot URL, e.g. `/tmp/shots/road-check.png`. */
  shot?: string;
  /**
   * Why this post has no screenshot, from `--nomedia`. Rendered, not just
   * recorded: an exception nobody sees is an exception nobody keeps rare.
   */
  nomedia?: string;
  /**
   * Comments only — who this is for. `["all"]` is a broadcast; anything else
   * names agents by the author string they post under. Every running agent is
   * shown every comment, but only the addressee is told to act on it, so this
   * field is the difference between a directive and context.
   */
  to?: string[];
  /** Comments and acks — the id of the entry this one answers. Required on an ack. */
  re?: string;
  /** Acks only — 👀 seen, 🔧 working, ✅ done, ❌ cannot. */
  emoji?: string;
  /**
   * Comments only — where it was written. `ui` can only be set by the dev
   * server's endpoint, so it marks the human's own dashboard; `cli` is a
   * command line, which in this repo means an agent. Rendered, because an
   * agent's paraphrase of an instruction shown as the human's own words is how
   * a relayed message becomes an order nobody gave.
   */
  via?: "ui" | "cli";
}

/** True for entries the human wrote at the agents rather than the other way round. */
export const isComment = (post: Post): boolean => post.kind === "comment";
