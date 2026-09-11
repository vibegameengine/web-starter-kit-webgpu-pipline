/**
 * The box you write a comment in. It opens **under the post being commented
 * on**, which is where a comment belongs and where every threaded discussion
 * puts it.
 *
 * An earlier version of this sat permanently at the top of the page, in the
 * shape of a new-post composer. That was the wrong model copied wholesale: a
 * new post is authored at the top of a timeline, a comment is attached to the
 * thing it is about. Detached from its post, a comment box asks the reader to
 * remember what they were reacting to and to re-state it — which is exactly the
 * work the attachment was supposed to save.
 *
 * The same box does broadcasts, opened deliberately from the top bar, with no
 * parent. Addressing is typed inline as `@name`, completed as you type; there is
 * no separate recipient field, because that splits one sentence across two inputs.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { AUTHOR_KEY, COMMENT_URL } from "../config";
import type { Post } from "../types";

type Status = "idle" | "sending" | "error";

/**
 * Same rule as `scripts/comment.mjs`, restated for the browser: that file is
 * Node (it imports `node:fs`) and cannot be bundled here. Keep the two regexes
 * identical — the server's parse is the one that counts, this one only decides
 * what the readout says.
 */
const MENTION = /@([\p{L}\p{N}][\p{L}\p{N}_.\-]*)/gu;
/** The `@word` being typed right now, if the caret sits at the end of one. */
const TYPING = /@([\p{L}\p{N}_.\-]*)$/u;

interface Props {
  /** Names seen in the feed, offered as completions so addressing does not rely on memory. */
  authors: string[];
  /** The post this comment is attached to. Absent for a broadcast. */
  parent?: Post;
  /** Close the box — after a successful send, or on cancel. */
  onDone: () => void;
  /** Re-read the feed so the new comment appears under its post immediately. */
  onPosted: () => void;
}

export function ReplyBox({ authors, parent, onDone, onPosted }: Props): ReactNode {
  const [author, setAuthor] = useState(() => localStorage.getItem(AUTHOR_KEY) ?? "");
  const [editingAuthor, setEditingAuthor] = useState(false);
  // Replying pre-addresses the comment, in the sentence, where it stays editable.
  const [text, setText] = useState(() => (parent ? `@${parent.author} ` : ""));
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");
  const [pick, setPick] = useState(0);
  const [suggestFor, setSuggestFor] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (author) localStorage.setItem(AUTHOR_KEY, author);
  }, [author]);

  const grow = useCallback(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, []);

  useEffect(() => {
    const el = box.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
    grow();
  }, [grow]);

  const mentioned = useMemo(() => [...text.matchAll(MENTION)].map((m) => m[1]), [text]);

  const suggestions = useMemo(() => {
    if (suggestFor === null) return [];
    const q = suggestFor.toLowerCase();
    return authors.filter((a) => a.toLowerCase().includes(q)).slice(0, 6);
  }, [authors, suggestFor]);

  const onType = useCallback(
    (value: string, caret: number) => {
      setText(value);
      const typing = value.slice(0, caret).match(TYPING);
      setSuggestFor(typing ? typing[1] : null);
      setPick(0);
      requestAnimationFrame(grow);
    },
    [grow],
  );

  const accept = useCallback(
    (name: string) => {
      const el = box.current;
      if (!el) return;
      const caret = el.selectionStart ?? text.length;
      const head = text.slice(0, caret).replace(TYPING, `@${name} `);
      const next = head + text.slice(caret);
      setText(next);
      setSuggestFor(null);
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(head.length, head.length);
        grow();
      });
    },
    [grow, text],
  );

  const send = useCallback(
    async (event?: FormEvent) => {
      event?.preventDefault();
      const body = text.trim();
      if (!body || status === "sending") return;
      setStatus("sending");
      setMessage("");
      try {
        const res = await fetch(COMMENT_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ author, text: body, re: parent?.id }),
        });
        if (!res.ok) throw new Error((await res.text()).trim() || `HTTP ${res.status}`);
        setText("");
        setStatus("idle");
        onPosted();
        onDone();
      } catch (err) {
        setStatus("error");
        // The likeliest cause by far is the page being open on a build rather
        // than the dev server, so say the actual fix, not just the error.
        setMessage(
          `${err instanceof Error ? err.message : String(err)} — the comment was not written. ` +
            "Comments work only on the dev server (npx vite).",
        );
      }
    },
    [author, onDone, onPosted, parent, status, text],
  );

  const onKey = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (suggestions.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setPick((i) => (i + 1) % suggestions.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setPick((i) => (i - 1 + suggestions.length) % suggestions.length);
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          accept(suggestions[pick]!);
          return;
        }
        if (e.key === "Escape") {
          setSuggestFor(null);
          return;
        }
      }
      if (e.key === "Escape") {
        onDone();
        return;
      }
      // Ctrl/Cmd+Enter sends; plain Enter keeps writing, because a comment worth
      // interrupting a running agent with is usually more than one line.
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
    },
    [accept, onDone, pick, send, suggestions],
  );

  const initials = (author.trim() || "?").slice(0, 2).toUpperCase();

  return (
    <form
      className="reply"
      data-testid={parent ? `feed-reply-${parent.id}` : "feed-reply-broadcast"}
      data-status={status}
      onSubmit={send}
    >
      <button
        type="button"
        className="reply-avatar"
        data-testid="feed-reply-author-open"
        title={author ? `You: ${author}` : "Who are you?"}
        onClick={() => setEditingAuthor((v) => !v)}
      >
        {initials}
      </button>

      <div className="reply-main">
        {editingAuthor ? (
          <input
            className="reply-name"
            data-testid="feed-reply-author"
            placeholder="your name"
            value={author}
            autoFocus
            onChange={(e) => setAuthor(e.target.value)}
            onBlur={() => setEditingAuthor(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "Escape") setEditingAuthor(false);
            }}
          />
        ) : null}

        <div className="reply-write">
          <textarea
            ref={box}
            className="reply-input"
            data-testid="feed-reply-input"
            placeholder={parent ? "Reply…" : "Tell every agent…"}
            rows={1}
            value={text}
            onChange={(e) => onType(e.target.value, e.target.selectionStart ?? 0)}
            onKeyDown={onKey}
          />
          {suggestions.length > 0 ? (
            <ul className="reply-mentions" data-testid="feed-reply-mentions">
              {suggestions.map((name, i) => (
                <li key={name}>
                  <button
                    type="button"
                    data-testid={`feed-reply-mention-${name}`}
                    data-selected={i === pick}
                    // mousedown, not click: the textarea's blur would otherwise
                    // close the list before the click lands.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      accept(name);
                    }}
                  >
                    @{name}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="reply-foot">
          {/* A readout, not a control: who is about to be told to act. */}
          <span
            className={`reply-target${mentioned.length === 0 ? " is-all" : ""}`}
            data-testid="feed-reply-target"
          >
            {mentioned.length === 0 ? "→ everyone" : mentioned.map((n) => `@${n}`).join(" ")}
          </span>
          <button type="button" className="reply-cancel" data-testid="feed-reply-cancel" onClick={onDone}>
            Cancel
          </button>
          <button
            type="submit"
            className="reply-send"
            data-testid="feed-reply-submit"
            disabled={!text.trim() || status === "sending"}
          >
            {status === "sending" ? "…" : "Send"}
          </button>
        </div>

        {message ? (
          <p className="reply-status" data-testid="feed-reply-status" role="alert">
            {message}
          </p>
        ) : null}
      </div>
    </form>
  );
}
