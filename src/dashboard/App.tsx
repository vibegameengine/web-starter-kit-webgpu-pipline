/**
 * The work feed — open /dashboard.html while a multi-agent pass is running.
 *
 * The page is one column of posts. Every agent appends to the feed file itself,
 * so the user reads the work as it happens rather than waiting for the manager
 * to relay it; comments go back the other way, written under the post they are
 * about, so watching a fan-out go wrong no longer leaves killing the run as the
 * only available move.
 *
 * Nothing sits permanently above the stream. A comment box lives under its post,
 * opened by "Reply"; the only detached one is the broadcast, which is opened
 * deliberately from the top bar and closes again after it is sent.
 *
 * The project's name and the feed's URL live in `config.ts`, not here.
 */

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { AgentRail } from "./components/AgentRail";
import { Feed } from "./components/Feed";
import { Header } from "./components/Header";
import { ReplyBox } from "./components/ReplyBox";
import { LEDE, TITLE } from "./config";
import { useAgents } from "./useAgents";
import { useFeed } from "./useFeed";
import { useNow } from "./useNow";

export function App(): ReactNode {
  // One nonce for the file and every <img>: bumping it re-reads the feed and
  // re-fetches the screenshots, which are overwritten in place as the loop runs.
  const [nonce, setNonce] = useState(() => Date.now());
  const reload = useCallback(() => setNonce(Date.now()), []);
  const now = useNow();
  const feed = useFeed(nonce);
  const agents = useAgents(nonce);
  const count = feed.data?.length ?? 0;

  const [broadcasting, setBroadcasting] = useState(false);
  const closeBroadcast = useCallback(() => setBroadcasting(false), []);

  // Whoever has posted is someone you can address. Agents name themselves in
  // the feed, so the completion list needs no registry to maintain.
  const authors = useMemo(() => {
    const seen = new Set<string>();
    for (const post of feed.data ?? []) if (post.kind !== "comment") seen.add(post.author);
    return [...seen];
  }, [feed.data]);

  return (
    <>
      <Header
        count={count}
        error={feed.data ? null : feed.error}
        onReload={reload}
        onBroadcast={() => setBroadcasting((v) => !v)}
        broadcasting={broadcasting}
      />
      <div className="shell">
        <AgentRail agents={agents.data} now={now} onChanged={reload} />
        <main className="page">
        <div className="page-head">
          <h1>{TITLE}</h1>
          <p className="lede">{LEDE}</p>
        </div>
        {broadcasting ? (
          <div className="broadcast" data-testid="feed-broadcast">
            <ReplyBox authors={authors} onDone={closeBroadcast} onPosted={reload} />
          </div>
        ) : null}
        <Feed
          posts={feed.data}
          error={feed.error}
          now={now}
          nonce={nonce}
          authors={authors}
          onPosted={reload}
        />
        </main>
      </div>
    </>
  );
}
