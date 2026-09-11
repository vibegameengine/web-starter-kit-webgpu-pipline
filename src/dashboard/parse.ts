/**
 * Defensive reader for the feed file.
 *
 * `feed.jsonl` is appended to by several processes at once, so a half-written
 * trailing line or a missing key is normal rather than exceptional. Nothing here
 * throws: bad input degrades to a shorter list, never to a blank page.
 */

import type { Post, PostKind } from "./types";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

const POST_KINDS: readonly PostKind[] = ["note", "done", "problem", "comment", "ack"];

function postKind(v: unknown): PostKind {
  return POST_KINDS.find((k) => k === v) ?? "note";
}

/**
 * A comment's addressees. An entry that names nobody is a broadcast, and is
 * normalised to `["all"]` here rather than at every render site — the difference
 * between "for everyone" and "for nobody" is the whole meaning of the field.
 */
function addressees(v: unknown): string[] {
  if (!Array.isArray(v)) return ["all"];
  const names = v.filter((n): n is string => typeof n === "string" && n.trim() !== "");
  return names.length > 0 ? names : ["all"];
}

/** One JSON object per line; a malformed or half-flushed line is skipped. */
export function toFeed(text: string): Post[] {
  const posts: Post[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(raw)) continue;
    const id = str(raw.id);
    const textBody = str(raw.text);
    const kind = postKind(raw.kind);
    const re = str(raw.re);
    // An ack is a receipt: an emoji and an id, with the text optional. Every
    // other kind is meaningless without a body.
    if (!id) continue;
    if (kind === "ack" ? !re : !textBody) continue;
    const shot = str(raw.shot);
    const nomedia = str(raw.nomedia);
    posts.push({
      id,
      at: str(raw.at),
      author: str(raw.author, "anonymous"),
      kind,
      text: textBody,
      ...(kind === "ack" ? { re, emoji: str(raw.emoji, "👀") } : {}),
      ...(shot ? { shot } : {}),
      ...(!shot && nomedia ? { nomedia } : {}),
      // Addressing is meaningless on an agent's own post, and carrying it there
      // would let a stray field render a "→ everyone" chip on a work update.
      ...(kind === "comment" ? { to: addressees(raw.to) } : {}),
      ...(kind === "comment" && re ? { re } : {}),
      // Anything that is not explicitly the dashboard is treated as a command
      // line. Entries written before this field existed are ambiguous, and the
      // safe reading of an ambiguous author is "not necessarily the human".
      ...(kind === "comment" ? { via: raw.via === "ui" ? ("ui" as const) : ("cli" as const) } : {}),
    });
  }
  // The file is append-only, so it is oldest-first on disk. The feed reads newest-first.
  return posts.reverse();
}
