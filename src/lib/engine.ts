import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import * as store from "./store";
import { dmId, teamId } from "./store";
import type { Agent, ModelId, Usage } from "./types";

/**
 * AgentStaff engine.
 *
 * Every thread is its own Claude conversation (like a separate Claude Code session). The CEO can talk to
 * several agents at once, and agents can message each other with the `message_colleague` tool. That call
 * opens (or continues) a team thread, runs the colleague's turn there, and returns the reply as the tool
 * result. Several colleague calls in one turn run in parallel.
 *
 * Runs entirely in the browser: the user's API key goes straight to api.anthropic.com.
 */

const MAX_DEPTH = 2; // CEO → agent (0) → colleague (1) → colleague (2, can't delegate further)
const MAX_TOOL_ROUNDS = 8;
const MAX_TASKS_PER_REQUEST = 6;

/** Shared by everything one CEO request sets in motion: cancellation, budget, task cap. */
interface RunContext {
  signal: AbortSignal;
  abort: () => void;
  budgetUsd: number;
  spentUsd: number;
  budgetHit: boolean;
  tasksCreated: number;
}

const SUPPORTS_FALLBACK_AND_SEARCH: ModelId[] = ["claude-opus-5-5", "claude-sonnet-5-5"];

/** USD per million tokens. Cache writes (5-minute TTL) cost 1.25x input; cache reads are much cheaper. */
const PRICES: Record<ModelId, { in: number; out: number; cacheRead: number }> = {
  "claude-opus-5-5": { in: 4, out: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { in: 2, out: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5, cacheRead: 0.01 },
};
const CACHE_WRITE_MULTIPLIER = 1.25;
const WEB_SEARCH_USD = 0.01;

export const MODEL_LABELS: Record<ModelId, string> = {
  "claude-opus-5-5": "Claude Opus 5.5 · best quality",
  "claude-sonnet-5-5": "Claude Sonnet 5.5 · faster, cheaper",
  "claude-haiku-5-5": "Claude Haiku 5.5 · fastest, cheapest",
};

// ---------- tools ----------

const MessageColleagueInput = z.object({ to: z.string(), message: z.string().min(1) });
const CreateTaskInput = z.object({ title: z.string().min(1), owner: z.string(), details: z.string() });
const UpdateTaskInput = z.object({
  task_id: z.string(),
  status: z.enum(["todo", "doing", "done", "blocked"]),
  note: z.string(),
});

function buildTools(agent: Agent, depth: number, chain: string[]): Anthropic.Beta.BetaToolUnion[] {
  const { org } = store.getState();
  const everyone = org.agents.map((a) => a.id);
  // The agent the CEO is talking to can reach the whole team. Everyone else delegates only to their own
  // direct reports, like a real org chart. (A live test showed unrestricted agents messaging everyone.)
  const reachable = org.agents
    .filter((a) => !chain.includes(a.id) && (depth === 0 || a.reportsTo === agent.id))
    .map((a) => a.id);
  const tools: Anthropic.Beta.BetaToolUnion[] = [];

  if (depth < MAX_DEPTH && reachable.length > 0) {
    tools.push({
      name: "message_colleague",
      description:
        "Send a message to a colleague and wait for their reply. Use it to delegate work or ask for input " +
        "(estimates, numbers, research, reviews). Call it several times in the same turn to work with " +
        "several colleagues in parallel. Write a complete, self-contained request: they can't see your other chats.",
      strict: true,
      eager_input_streaming: true,
      input_schema: {
        type: "object",
        properties: {
          to: { type: "string", enum: reachable, description: "Colleague's id" },
          message: { type: "string", description: "Your full request" },
        },
        required: ["to", "message"],
        additionalProperties: false,
      },
    });
  }
  tools.push({
    name: "view_task_board",
    description: "See every task on the shared task board with its id, owner and status. Check it before creating tasks.",
    strict: true,
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  });
  if (depth > 1) return withSearch(tools, agent);
  tools.push(
    {
      name: "create_task",
      description:
        "Add a task to the shared task board for work that outlives this conversation. Never duplicate an " +
        "existing task: update it instead.",
      strict: true,
      eager_input_streaming: true,
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string" },
          owner: { type: "string", enum: everyone, description: "Owner's agent id" },
          details: { type: "string", description: "What done looks like" },
        },
        required: ["title", "owner", "details"],
        additionalProperties: false,
      },
    },
    {
      name: "update_task",
      description: "Change a task's status on the shared task board.",
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          task_id: { type: "string" },
          status: { type: "string", enum: ["todo", "doing", "done", "blocked"] },
          note: { type: "string", description: "One line on what changed" },
        },
        required: ["task_id", "status", "note"],
        additionalProperties: false,
      },
    },
  );
  return withSearch(tools, agent);
}

function withSearch(tools: Anthropic.Beta.BetaToolUnion[], agent: Agent) {
  const { settings } = store.getState();
  if (settings.allowWebSearch && agent.tools.includes("web_search") && SUPPORTS_FALLBACK_AND_SEARCH.includes(settings.model)) {
    tools.push({ type: "web_search_20260209", name: "web_search", max_uses: 5 });
  }
  return tools;
}

function systemPrompt(agent: Agent) {
  const { org } = store.getState();
  const roster = org.agents
    .map((a) => {
      const boss = a.reportsTo ? org.agents.find((b) => b.id === a.reportsTo)?.name ?? "the CEO" : "the CEO";
      return `- ${a.id}: ${a.name}, ${a.title} (reports to ${boss})`;
    })
    .join("\n");
  return (
    `You are ${agent.name}, ${agent.title} at a company whose CEO is the human you work for. ` +
    `Your colleagues are AI agents too.\n\nYour role: ${agent.mission}\n\nThe team:\n${roster}\n\n` +
    `How you work:\n` +
    `- Answer directly when you can. Delegate with message_colleague only when a colleague's expertise ` +
    `clearly improves the answer: usually 2-4 colleagues, asked in parallel in one turn, not one after another.\n` +
    `- When a colleague asks you something, answer it yourself; involve others only if truly necessary.\n` +
    `- Put only significant work items on the task board (a few, not dozens). Check the board first and ` +
    `never duplicate a task; update the existing one instead.\n` +
    `- Write in concise markdown. Use small tables for numbers. Label estimates and assumptions.\n` +
    `- When colleagues contributed, say who found what.`
  );
}

// ---------- running a turn ----------

const locks = new Map<string, Promise<unknown>>();

/** Serialize turns within one thread (different threads run in parallel). */
function withThreadLock<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(threadId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  locks.set(threadId, next);
  return next;
}

const controllers = new Map<string, AbortController>();

export function isConfigured() {
  return store.getState().settings.apiKey.trim().length > 0;
}

/** The CEO sends a message in a DM. Returns when the agent (and anyone it delegated to) is done. */
export async function sendFromCeo(agentId: string, text: string) {
  const threadId = dmId(agentId);
  store.ensureThread(threadId, "dm", [agentId]);
  store.addMessage(threadId, "ceo", text);
  store.pushHistory(threadId, { role: "user", content: `Message from the CEO:\n${text}` });

  const controller = new AbortController();
  controllers.set(threadId, controller);
  const ctx: RunContext = {
    signal: controller.signal,
    abort: () => controller.abort(),
    budgetUsd: store.getState().settings.maxCostPerRequest,
    spentUsd: 0,
    budgetHit: false,
    tasksCreated: 0,
  };
  try {
    await withThreadLock(threadId, () => runTurn(threadId, agentId, 0, [agentId], ctx));
  } finally {
    controllers.delete(threadId);
  }
}

export function stopThread(threadId: string) {
  controllers.get(threadId)?.abort();
}

async function runTurn(threadId: string, agentId: string, depth: number, chain: string[], ctx: RunContext): Promise<string> {
  const { signal } = ctx;
  const agent = store.getState().org.agents.find((a) => a.id === agentId);
  if (!agent) throw new Error(`Unknown agent ${agentId}`);
  const { settings } = store.getState();
  const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
  const safety = SUPPORTS_FALLBACK_AND_SEARCH.includes(settings.model)
    ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
    : {};

  store.setBusy(threadId, true);
  let finalText = "";
  let bubble: string | null = null;   // the reply currently streaming in this thread
  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (ctx.spentUsd >= ctx.budgetUsd) stopForBudget(ctx);
      bubble = store.addMessage(threadId, agentId, "", { streaming: true });

      const stream = client.beta.messages.stream(
        {
          model: settings.model,
          max_tokens: 32000,
          ...safety,
          output_config: { effort: settings.effort },
          // Prompt caching: an explicit breakpoint on the static prefix (tools + system prompt), plus automatic
          // caching of the growing conversation. Each tool round re-sends the history, so this is the biggest
          // cost lever: cached input is billed at 5-10% of the normal price.
          cache_control: { type: "ephemeral" },
          system: [{ type: "text", text: systemPrompt(agent), cache_control: { type: "ephemeral" } }],
          tools: buildTools(agent, depth, chain),
          messages: store.getState().threads[threadId].history,
        },
        { signal },
      );
      stream.on("streamEvent", (ev) => {
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          store.appendToMessage(threadId, bubble!, ev.delta.text);
        } else if (ev.type === "content_block_start" && ev.content_block.type === "server_tool_use") {
          // Close the current bubble so the note appears in order, then keep streaming into a new one.
          store.finishMessage(threadId, bubble!);
          store.addMessage(threadId, agentId, "Searching the web", { kind: "note" });
          bubble = store.addMessage(threadId, agentId, "", { streaming: true });
        }
      });

      const msg = await stream.finalMessage();
      store.finishMessage(threadId, bubble);
      ctx.spentUsd += recordUsage(settings.model, msg.usage);
      // Append-only history: the assistant turn goes back exactly as received (thinking blocks included).
      store.pushHistory(threadId, { role: "assistant", content: msg.content });
      if (ctx.spentUsd >= ctx.budgetUsd) stopForBudget(ctx);
      const text = msg.content.filter((b) => b.type === "text").map((b) => (b as Anthropic.Beta.BetaTextBlock).text).join("");
      if (text.trim()) finalText = text;

      if (msg.stop_reason === "refusal") {
        store.addMessage(threadId, agentId, "I can't help with that request.", { kind: "error" });
        return "(declined)";
      }
      if (msg.stop_reason === "pause_turn") {
        // A long server-tool turn paused. Re-send as-is (no extra user message): the API resumes it.
        continue;
      }
      if (msg.stop_reason === "max_tokens") {
        // Tool inputs may be truncated; don't run them.
        store.addMessage(threadId, agentId, "My reply hit the length limit. Ask me to continue or narrow the request.", { kind: "error" });
        repairHistory(threadId);
        break;
      }

      const calls = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (msg.stop_reason !== "tool_use" || calls.length === 0) break;

      // Run every tool call from this turn in parallel; return all results in one message.
      const results = await Promise.all(
        calls.map((call) => runTool(call, threadId, agent, depth, chain, ctx)),
      );
      store.pushHistory(threadId, { role: "user", content: results });
    }
    return finalText || "(no reply)";
  } catch (err) {
    if (signal.aborted) {
      const why = ctx.budgetHit
        ? `Stopped: this request reached its $${ctx.budgetUsd.toFixed(2)} budget (change it in Settings).`
        : "Stopped.";
      store.addMessage(threadId, agentId, why, { kind: "note" });
      repairHistory(threadId);
      throw err;
    }
    const message = describeError(err);
    store.addMessage(threadId, agentId, message, { kind: "error" });
    // Keep history valid: a dangling user turn is fine to retry from; a dangling tool_use is not.
    repairHistory(threadId);
    return `(error: ${message})`;
  } finally {
    // Close any reply bubble left open by an error or a stop (an empty one is removed).
    if (bubble) store.finishMessage(threadId, bubble);
    store.setBusy(threadId, false);
  }
}

async function runTool(
  call: Anthropic.Beta.BetaToolUseBlock,
  threadId: string,
  agent: Agent,
  depth: number,
  chain: string[],
  ctx: RunContext,
): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
  const ok = (content: string): Anthropic.Beta.BetaToolResultBlockParam => ({ type: "tool_result", tool_use_id: call.id, content });
  const fail = (content: string): Anthropic.Beta.BetaToolResultBlockParam => ({ ...ok(content), is_error: true });
  const { org } = store.getState();

  if (call.name === "message_colleague") {
    // eager_input_streaming means the API doesn't validate inputs for us: validate before acting.
    const parsed = MessageColleagueInput.safeParse(call.input);
    if (!parsed.success) return fail("Invalid input. Provide `to` (a colleague id) and `message`.");
    const { to, message } = parsed.data;
    const colleague = org.agents.find((a) => a.id === to);
    if (!colleague || chain.includes(to)) return fail(`You can't message "${to}" from here.`);

    const tId = teamId(agent.id, to);
    store.ensureThread(tId, "team", [agent.id, to]);
    store.addMessage(threadId, agent.id, `Asked ${colleague.name} (${colleague.title}): ${message}`, {
      kind: "note",
      linkThreadId: tId,
    });
    const reply = await withThreadLock(tId, async () => {
      store.addMessage(tId, agent.id, message);
      store.pushHistory(tId, {
        role: "user",
        content: `Message from your colleague ${agent.name} (${agent.title}):\n${message}`,
      });
      return runTurn(tId, to, depth + 1, [...chain, to], ctx);
    });
    store.addMessage(threadId, agent.id, `${colleague.name} replied`, { kind: "note", linkThreadId: tId });
    return ok(`${colleague.name} (${colleague.title}) replied:\n${reply}`);
  }

  if (call.name === "view_task_board") {
    const { tasks } = store.getState();
    if (tasks.length === 0) return ok("The task board is empty.");
    return ok(
      tasks
        .map((t) => `${t.id} [${t.status}] ${t.title} (owner: ${t.owner}) ${t.details ? `— ${t.details}` : ""}`)
        .join("\n"),
    );
  }

  if (call.name === "create_task") {
    const parsed = CreateTaskInput.safeParse(call.input);
    if (!parsed.success || !org.agents.some((a) => a.id === parsed.data.owner)) {
      return fail("Invalid input. Provide title, owner (an agent id) and details.");
    }
    const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const dupe = store.getState().tasks.find((t) => norm(t.title) === norm(parsed.data.title));
    if (dupe) return fail(`That task already exists as ${dupe.id}. Update it instead.`);
    if (ctx.tasksCreated >= MAX_TASKS_PER_REQUEST) {
      return fail("The task limit for this request is reached. Update existing tasks instead.");
    }
    ctx.tasksCreated++;
    const task = store.createTask({ ...parsed.data, status: "todo", createdBy: agent.id });
    store.addMessage(threadId, agent.id, `Added ${task.id} to the board: ${task.title}`, { kind: "note" });
    return ok(`Created ${task.id}.`);
  }

  if (call.name === "update_task") {
    const parsed = UpdateTaskInput.safeParse(call.input);
    if (!parsed.success) return fail("Invalid input. Provide task_id, status and note.");
    const task = store.updateTask(parsed.data.task_id, { status: parsed.data.status });
    if (!task) return fail(`No task with id ${parsed.data.task_id}. Use view_task_board to see ids.`);
    store.addMessage(threadId, agent.id, `Moved ${task.id} to ${task.status}: ${parsed.data.note}`, { kind: "note" });
    return ok(`Updated ${task.id}.`);
  }

  return fail(`Unknown tool ${call.name}.`);
}

/** After a failed turn, drop a trailing assistant tool_use turn that never got its results. */
function repairHistory(threadId: string) {
  const t = store.getState().threads[threadId];
  const last = t.history[t.history.length - 1];
  if (last?.role === "assistant" && Array.isArray(last.content) && last.content.some((b) => b.type === "tool_use")) {
    store.pushHistory(threadId, {
      role: "user",
      content: last.content
        .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use")
        .map((b) => ({ type: "tool_result" as const, tool_use_id: b.id, content: "Interrupted.", is_error: true })),
    });
  }
}

function stopForBudget(ctx: RunContext): never {
  ctx.budgetHit = true;
  ctx.abort(); // cancels every in-flight sub-conversation of this request
  throw new DOMException("Budget reached", "AbortError");
}

/** Adds this response's usage to the workspace meter and returns its estimated cost in USD. */
function recordUsage(model: ModelId, u: Anthropic.Beta.BetaUsage): number {
  const fresh = u.input_tokens ?? 0;
  const written = u.cache_creation_input_tokens ?? 0;
  const read = u.cache_read_input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const searches = u.server_tool_use?.web_search_requests ?? 0;
  const p = PRICES[model];
  const delta: Usage = {
    inputTokens: fresh + written + read,
    cachedTokens: read,
    outputTokens: output,
    webSearches: searches,
    costUsd:
      (fresh * p.in + written * p.in * CACHE_WRITE_MULTIPLIER + read * p.cacheRead + output * p.out) / 1_000_000 +
      searches * WEB_SEARCH_USD,
  };
  store.addUsage(delta);
  return delta.costUsd;
}

export function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "Your API key was rejected. Check it in Settings.";
  if (err instanceof Anthropic.PermissionDeniedError) return "This API key doesn't have access to that model.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the API. Wait a minute and try again.";
  if (err instanceof Anthropic.BadRequestError) return `The API rejected the request: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach the Anthropic API. Check your connection.";
  if (err instanceof Anthropic.APIError) return `API error ${err.status ?? ""}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
