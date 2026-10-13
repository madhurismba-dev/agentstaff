"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useEffect, type ReactNode } from "react";
import type { Agent, Thread, WorkspaceState } from "@/lib/types";

/** Who answers in a thread: the agent in a DM, the second member in a team thread. */
export const responderOf = (t: Thread) => (t.kind === "dm" ? t.members[0] : t.members[1]);

export function isAgentBusy(s: WorkspaceState, agentId: string) {
  return Object.values(s.threads).some((t) => t.busy && responderOf(t) === agentId);
}

export function Avatar({ agent, size = 32, busy = false }: { agent?: Agent; size?: number; busy?: boolean }) {
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      <span
        className="grid h-full w-full place-items-center rounded-lg"
        style={{ background: agent ? `${agent.color}22` : "#4f46e522", fontSize: size * 0.52 }}
        aria-hidden
      >
        {agent?.emoji ?? "👤"}
      </span>
      {busy && (
        <span
          className="working-dot absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2 border-sidebar bg-emerald-400"
          title="Working"
        />
      )}
    </span>
  );
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ a: (props) => <a {...props} target="_blank" rel="noopener noreferrer" /> }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`max-h-[90vh] w-full overflow-y-auto rounded-2xl border border-line bg-panel p-6 shadow-2xl ${wide ? "max-w-2xl" : "max-w-lg"}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded-md px-2 py-1 text-muted hover:bg-accent-soft" aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export const inputCls =
  "w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20";
export const btnPrimary =
  "rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40";
export const btnGhost = "rounded-lg border border-line px-4 py-2 text-sm hover:bg-accent-soft disabled:opacity-40";
