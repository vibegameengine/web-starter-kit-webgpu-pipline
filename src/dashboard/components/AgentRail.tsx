/**
 * The left rail: who is working, and on what.
 *
 * The feed answers "what was found". This answers the question a person asks
 * first and most often - is anything happening, and by whom - which the feed
 * answers badly, because an agent that has found nothing yet posts nothing and
 * is indistinguishable from an agent that died.
 *
 * Every row is written by the agent's own tool calls. Nothing here is declared:
 * `presence.mjs` derives the status line from the call itself, so a row cannot
 * say "building" an hour after the build ended.
 */

import { useCallback, useState, type ReactNode } from "react";
import { liveness, minutesSince, type Agent } from "../useAgents";

function ago(iso: string | undefined, now: number): string {
  const m = minutesSince(iso, now);
  if (m === null) return "—";
  if (m < 1) return "сейчас";
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} ч` : `${Math.floor(h / 24)} д`;
}

/** The worktree is the only part of a path anybody reads at a glance. */
function tree(cwd: string | undefined): string | null {
  if (!cwd) return null;
  const m = /\.worktrees\/([^/]+)/.exec(cwd.replace(/\\/g, "/"));
  if (m) return m[1];
  const leaf = cwd.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop();
  return leaf ?? null;
}

/**
 * Remove, in two presses.
 *
 * The first press arms it and says so; the second does it. Not a modal, which
 * stops the reading you were doing to ask a question you have already answered;
 * not a single press, which deletes the wrong row the first time a hand slips
 * on a list that reorders itself under the cursor - and this one does, on every
 * tool call any agent makes.
 *
 * The armed state times out. A button left hot is a trap for the next click,
 * and the next click here is usually somebody scrolling back to read a status.
 */
function RemoveButton({ id, name, onRemoved }: {
  id: string;
  name: string;
  onRemoved: () => void;
}): ReactNode {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const click = useCallback(async () => {
    if (!armed) {
      setArmed(true);
      window.setTimeout(() => setArmed(false), 4000);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/__feed/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) throw new Error(await res.text());
      onRemoved();
    } catch (err) {
      // Said out loud rather than swallowed: without the dev middleware this
      // 404s, and a delete button that silently does nothing is worse than one
      // that is not there.
      setError(String(err));
      setArmed(false);
    } finally {
      setBusy(false);
    }
  }, [armed, id, onRemoved]);

  return (
    <>
      <button
        type="button"
        className={`rail-remove${armed ? " is-armed" : ""}`}
        onClick={() => void click()}
        disabled={busy}
        aria-label={armed ? `Точно убрать ${name}?` : `Убрать ${name} из списка`}
        title={armed ? "Ещё раз — и строка исчезнет" : "Убрать из списка"}
        data-testid="agent-remove"
      >
        {busy ? "…" : armed ? "точно?" : "×"}
      </button>
      {error ? <span className="rail-error" title={error}>не удалось</span> : null}
    </>
  );
}

export function AgentRail({ agents, now, onChanged }: {
  agents: Agent[] | null;
  now: number;
  onChanged: () => void;
}): ReactNode {
  // Never hidden when empty. An empty rail with its own explanation is how an
  // agent learns the registry exists; a rail that appears only once somebody
  // has registered teaches nobody anything.
  const list = agents ?? [];
  const live = list.filter((a) => liveness(a.lastSeen, now) === "live").length;

  return (
    <aside className="rail" data-testid="agent-rail">
      <div className="rail-head">
        <span className="rail-title">Агенты</span>
        <span className="rail-count">{live} из {list.length} активны</span>
      </div>

      {list.length === 0 ? (
        <p className="rail-empty">
          Никто ещё не представился. Агент попадает сюда сам, одной командой —
          хук <code>presence.mjs</code> печатает её на первом же вызове
          инструмента.
        </p>
      ) : (
        <ul className="rail-list">
          {list.map((a) => {
            const state = liveness(a.lastSeen, now);
            const wt = tree(a.cwd);
            return (
              <li key={a.id} className={`rail-agent is-${state}`} data-testid="agent-row">
                <div className="rail-agent-top">
                  <span className={`rail-dot is-${state}`} aria-hidden="true" />
                  <span className="rail-name">{a.name}</span>
                  <span className="rail-seen">{ago(a.lastSeen, now)}</span>
                  <RemoveButton id={a.id} name={a.name} onRemoved={onChanged} />
                </div>
                <div className="rail-status">{a.status ?? "—"}</div>
                <div className="rail-goal" title={a.goal}>{a.goal}</div>
                <div className="rail-meta">
                  {wt ? <span className="rail-tree">{wt}</span> : null}
                  <span className="rail-id">#{a.id}</span>
                  {a.calls ? <span className="rail-calls">{a.calls} вызовов</span> : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}


