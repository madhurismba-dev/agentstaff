"use client";

import * as store from "@/lib/store";
import { dmId, useWorkspace } from "@/lib/store";
import type { Agent } from "@/lib/types";
import { Avatar, isAgentBusy } from "./ui";

export function OrgChart({ onEdit, onHire }: { onEdit: (a: Agent) => void; onHire: () => void }) {
  const s = useWorkspace((x) => x);
  const childrenOf = (id: string | null) => s.org.agents.filter((a) => (a.reportsTo ?? null) === id);
  const openTasks = (id: string) => s.tasks.filter((t) => t.owner === id && t.status !== "done").length;

  const Node = ({ agent }: { agent: Agent }) => {
    const kids = childrenOf(agent.id);
    const busy = isAgentBusy(s, agent.id);
    return (
      <li className="org-node">
        <div
          className={`group relative mx-auto w-44 rounded-xl border bg-panel p-3 text-center shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${
            busy ? "border-emerald-400 ring-2 ring-emerald-400/30" : "border-line"
          }`}
        >
          <button
            onClick={() => store.setView({ kind: "thread", threadId: dmId(agent.id) })}
            className="block w-full"
            title={`Chat with ${agent.name}`}
          >
            <div className="flex justify-center">
              <Avatar agent={agent} size={40} />
            </div>
            <div className="mt-2 truncate text-sm font-semibold">{agent.name}</div>
            <div className="truncate text-xs text-muted">{agent.title}</div>
            <div className="mt-2 flex items-center justify-center gap-1.5 text-[11px]">
              {busy ? (
                <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                  <span className="working-dot h-1.5 w-1.5 rounded-full bg-emerald-500" /> Working
                </span>
              ) : (
                <span className="text-muted">Idle</span>
              )}
              {openTasks(agent.id) > 0 && <span className="text-muted">· {openTasks(agent.id)} tasks</span>}
            </div>
          </button>
          <button
            onClick={() => onEdit(agent)}
            className="absolute top-1.5 right-1.5 rounded px-1.5 text-xs text-muted opacity-0 group-hover:opacity-100 hover:bg-accent-soft focus:opacity-100"
            aria-label={`Edit ${agent.name}`}
          >
            Edit
          </button>
        </div>
        {kids.length > 0 && (
          <ul>
            {kids.map((k) => (
              <Node key={k.id} agent={k} />
            ))}
          </ul>
        )}
      </li>
    );
  };

  const top = childrenOf(null);
  return (
    <section className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-line bg-panel px-5 py-3">
        <div>
          <h1 className="font-semibold">Org chart</h1>
          <p className="text-xs text-muted">Click anyone to chat. Green means they&apos;re working right now.</p>
        </div>
        <button onClick={onHire} className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white">
          + Hire agent
        </button>
      </header>
      <div className="flex-1 overflow-auto p-8">
        <ul className="org-tree mx-auto w-max">
          <li className="org-node">
            <div className="mx-auto w-44 rounded-xl border-2 border-zinc-800 bg-zinc-900 p-3 text-center text-white dark:border-zinc-300 dark:bg-zinc-100 dark:text-zinc-900">
              <div className="text-2xl">👤</div>
              <div className="mt-1 text-sm font-semibold">You</div>
              <div className="text-xs opacity-70">CEO</div>
            </div>
            {top.length > 0 && (
              <ul>
                {top.map((a) => (
                  <Node key={a.id} agent={a} />
                ))}
              </ul>
            )}
          </li>
        </ul>
      </div>
    </section>
  );
}
