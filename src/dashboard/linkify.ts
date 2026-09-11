/**
 * Turn the bare URLs agents type into linkable segments.
 *
 * Posts are plain text written from a shell, so a harness page arrives either
 * absolute (`http://localhost:5173/world-test.html?view=top`) or root-relative
 * (`/world-test.html?view=top`). Both should be clickable; nothing else in the
 * text should be. This returns SEGMENTS rather than HTML on purpose — the feed
 * renders real React nodes, so no post can inject markup.
 */

export interface TextSegment {
  kind: "text";
  value: string;
}

export interface LinkSegment {
  kind: "link";
  /** Where it goes. */
  href: string;
  /** What it reads as — the origin is dropped, it is noise in every post. */
  label: string;
}

export type Segment = TextSegment | LinkSegment;

/**
 * Absolute http(s) URLs, or root-relative paths that clearly name a file
 * (`/world-test.html?view=top`, `/tmp/shots/x.png`). A bare `src/scene/sky.ts`
 * is NOT matched: source paths are mentioned constantly and are not links.
 *
 * Two rules the alternation has to respect, both learned by getting them wrong:
 *
 *   - LONGEST EXTENSION FIRST. Alternation is ordered, so `json` before `jsonl`
 *     turned "/tmp/dashboard/feed.jsonl" into a link to `…/feed.json` plus a
 *     stray "l" — a 404 and a typo in the one path this project names most.
 *   - THE PATH MUST START A TOKEN. The leading `/` only counts at the start of
 *     the text or after whitespace or an opening bracket. Without that,
 *     "copy scripts/post.mjs there" rendered as the word "scripts" followed by a
 *     link to "/post.mjs", which does not exist — and contradicted the promise
 *     right above that bare source paths are not matched.
 */
const PATTERN =
  /(https?:\/\/[^\s<>"'`]+)|((?<=^|[\s([{<"'`])\/[\w.\-/]*\.(?:jsonl|json|jpeg|jpg|html|png|webp|gif|mjs|glb)(?:\?[\w=&.\-%+/]*)?)/gu;

/** Trailing sentence punctuation is part of the prose, not of the URL. */
function trimTrailing(url: string): { url: string; rest: string } {
  const match = /[.,;:!?)\]}'"]+$/u.exec(url);
  if (!match) return { url, rest: "" };
  // A closing bracket is only punctuation if it was never opened inside the URL.
  const head = url.slice(0, match.index);
  return { url: head, rest: url.slice(match.index) };
}

function label(href: string): string {
  try {
    const parsed = new URL(href, "http://local");
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return href;
  }
}

export function linkify(text: string): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;

  const pushText = (value: string): void => {
    if (!value) return;
    const last = segments[segments.length - 1];
    if (last?.kind === "text") last.value += value;
    else segments.push({ kind: "text", value });
  };

  for (const match of text.matchAll(PATTERN)) {
    const raw = match[0];
    const start = match.index ?? 0;
    const { url, rest } = trimTrailing(raw);
    if (!url) continue;
    pushText(text.slice(cursor, start));
    segments.push({ kind: "link", href: url, label: label(url) });
    pushText(rest);
    cursor = start + raw.length;
  }
  pushText(text.slice(cursor));
  return segments;
}
