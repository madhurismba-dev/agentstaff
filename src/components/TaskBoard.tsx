"use client";

import * as store from "@/lib/store";
import { dmId, useWorkspace } from "@/lib/store";
import type { TaskStatus } from "@/lib/types";
import { Avatar } from "./ui";

const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: "todo", label: "To do" },
  { status: "doing", label: "In progress" },
  { status: "blocked", label: "Blocked" },
  { status: "done", label: "Done" },
];

export function TaskBoard() {
  const tasks = useWorkspace((s) => s.tasks);
  const agents = useWorkspace((s) => s.org.agents);

  return (
    <section className="flex h-full flex-col">
      <header className="border-b border-line bg-panel px-5 py-3">
        <h1 className="font-semibold">Task board</h1>
        <p className="text-xs text-muted">Your agents add and update tasks here as they work. You can move them too.</p>
      </header>
      {tasks.length === 0 ? (
        <div className="grid flex-1 place-items-center p-8 text-center text-sm text-muted">
          <div>
            <div className="text-3xl">📋</div>
            <p className="mt-2 max-w-sm">No tasks yet. Give your Chief of Staff a goal and the team will fill this board.</p>
          </div>
        </div>
      ) : (
        <div className="grid flex-1 grid-cols-1 gap-4 overflow-auto p-5 sm:grid-cols-2 xl:grid-cols-4">
          {COLUMNS.map((col) => {
            const items = tasks.filter((t) => t.status === col.status);
            return (
              <div key={col.status} className="flex min-h-40 flex-col rounded-xl bg-accent-soft/40 p-3">
                <div className="mb-2 flex items-center justify-between px-1 text-sm font-semibold">
                  {col.label} <span className="text-xs font-normal text-muted">{items.length}</span>
                </div>
                <div className="space-y-2">
                  {items.map((t) => {
                    const owner = agents.find((a) => a.id === t.owner);
                    return (
                      <article key={t.id} className="rounded-lg border border-line bg-panel p-3 shadow-sm">
                        <div className="text-[11px] text-muted">{t.id}</div>
                        <h3 className="text-sm font-medium">{t.title}</h3>
                        {t.details && <p className="mt-1 line-clamp-3 text-xs text-muted">{t.details}</p>}
                        <div className="mt-2 flex items-center justify-between gap-2">
                          <button
                            onClick={() => owner && store.setView({ kind: "thread", threadId: dmId(owner.id) })}
                            className="flex min-w-0 items-center gap-1.5 text-xs hover:underline"
                          >
                            <Avatar agent={owner} size={20} />
                            <span className="truncate">{owner?.name ?? t.owner}</span>
                          </button>
                          <select
                            value={t.status}
                            onChange={(e) => store.updateTask(t.id, { status: e.target.value as TaskStatus })}
                            className="rounded border border-line bg-bg px-1 py-0.5 text-xs"
                            aria-label={`Status of ${t.title}`}
                          >
                            {COLUMNS.map((c) => (
                              <option key={c.status} value={c.status}>
                                {c.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
