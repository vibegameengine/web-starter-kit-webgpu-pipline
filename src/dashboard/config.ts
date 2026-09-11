/**
 * Everything about this dashboard that is specific to YOUR project.
 *
 * Edit this file after copying the dashboard in; nothing else in `app/` names a
 * project. (The one thing that cannot live here is the `<title>` in
 * `dashboard.html` — plain HTML, no imports — so change that too.)
 */

/** Shown in the floating bar, top left. Your project's name. */
export const BRAND = "Elderwood";

/** The page's own heading. "Work feed" is usually right; it is what this is. */
export const TITLE = "Elderwood work feed";

/** One line under the heading, telling a first-time reader what they are looking at. */
export const LEDE = "Лента работы агентов: сначала находка, затем исправление. Ответьте под постом — исполнитель получит её после следующего tool call.";

/**
 * Where the browser fetches the feed. MUST resolve to the same file
 * `scripts/post.mjs` appends to (its `FEED` constant), and must be under the dev
 * server's root — a path outside it 404s and the page sits on its empty state
 * with nothing to say why. Default pair: `tmp/dashboard/feed.jsonl` on disk,
 * this URL over HTTP.
 */
export const FEED_URL = "/tmp/dashboard/feed.jsonl";

/** How the empty state tells a reader to post. Keep it copy-pasteable. */
export const POST_COMMAND = "scripts/post.mjs";

/**
 * Where the composer sends a comment. Served by a dev-only Vite middleware (see
 * `vite.config.ts`), because a static file server has nowhere to put a POST.
 *
 * There is no production equivalent on purpose: the feed is session state for a
 * running fan-out, and an endpoint that appends to a file on disk has no
 * business in a build anyone ships. Without the dev server the composer fails
 * loudly and `scripts/comment.mjs` still works from a terminal.
 */
export const COMMENT_URL = "/__feed/comment";

/** Remembers who you are between reloads, so the name is typed once per machine. */
export const AUTHOR_KEY = "agent-work-feed:author";
