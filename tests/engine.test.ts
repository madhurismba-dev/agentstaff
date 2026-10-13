/**
 * Engine test with a fake Anthropic API (no network, no cost).
 * Scenario: the CEO asks Avery (Chief of Staff) for a plan. Avery messages Priya (PM) and Fiona (CFO)
 * in parallel; Priya messages Eli (Engineering) and creates a task; everyone replies; Avery summarizes.
 *
 * Run: npm test
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { sendFromCeo } from "../src/lib/engine";
import * as store from "../src/lib/store";
import { TEMPLATES, cloneOrg } from "../src/lib/templates";

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

interface Captured {
  agent: string;
  body: Record<string, unknown>;
  headers: Headers;
  start: number;
  end: number;
}
const calls: Captured[] = [];
let toolCounter = 0;
const tool = (name: string, input: Record<string, unknown>): Block => ({ type: "tool_use", id: `toolu_${++toolCounter}`, name, input });

/** Decide the fake model's reply from who is speaking and how far the conversation has gone. */
function script(agent: string, messages: { role: string; content: unknown }[]): { blocks: Block[]; delay: number } {
  const turns = messages.filter((m) => m.role === "assistant").length;
  switch (agent) {
    case "Avery":
      return turns === 0
        ? {
            delay: 10,
            blocks: [
              { type: "text", text: "On it. Looping in Priya and Fiona." },
              tool("message_colleague", { to: "pm", message: "Scope a free trial." }),
              tool("message_colleague", { to: "cfo", message: "Model the trial economics." }),
            ],
          }
        : { delay: 10, blocks: [{ type: "text", text: "Recommendation: launch the trial." }] };
    case "Priya":
      return turns === 0
        ? {
            delay: 30,
            blocks: [
              tool("message_colleague", { to: "dev", message: "Estimate the trial build." }),
              tool("create_task", { title: "Ship trial MVP", owner: "dev", details: "4 weeks" }),
            ],
          }
        : { delay: 10, blocks: [{ type: "text", text: "Scope: 14 days, 3 seats." }] };
    case "Eli":
      return { delay: 40, blocks: [{ type: "text", text: "About 4 weeks." }] };
    case "Fiona":
      return { delay: 60, blocks: [{ type: "text", text: "Net positive at 9% conversion." }] };
    default:
      throw new Error(`Unexpected agent ${agent}`);
  }
}

/** Build a valid Messages API server-sent-event stream from a list of content blocks. */
function sse(blocks: Block[]): string {
  const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  let out = ev("message_start", {
    type: "message_start",
    message: {
      id: `msg_${toolCounter}_${calls.length}`,
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 1 },
    },
  });
  blocks.forEach((b, index) => {
    if (b.type === "text") {
      out += ev("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      out += ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } });
    } else {
      out += ev("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: b.id, name: b.name, input: {} },
      });
      out += ev("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) },
      });
    }
    out += ev("content_block_stop", { type: "content_block_stop", index });
  });
  const stop = blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
  out += ev("message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 50 } });
  out += ev("message_stop", { type: "message_stop" });
  return out;
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body));
  const system = Array.isArray(body.system) ? body.system.map((b: { text: string }) => b.text).join("") : body.system;
  const agent = /You are (\w+),/.exec(system)?.[1] ?? "?";
  const { blocks, delay } = script(agent, body.messages);
  const record: Captured = { agent, body, headers: new Headers(init?.headers), start: Date.now(), end: 0 };
  calls.push(record);
  await new Promise((r) => setTimeout(r, delay));
  record.end = Date.now();
  void input;
  return new Response(sse(blocks), { status: 200, headers: { "content-type": "text/event-stream" } });
}) as typeof fetch;

test("CEO → Chief of Staff delegates in parallel, nested delegation, tasks, final answer", async () => {
  store.replaceWorkspace(
    store.freshWorkspace(cloneOrg(TEMPLATES[0]), { ...store.DEFAULT_SETTINGS, apiKey: "sk-ant-test" }),
  );

  await sendFromCeo("chief", "Should we launch a free trial?");
  const s = store.getState();

  // Every agent that should have worked did.
  assert.deepEqual(new Set(calls.map((c) => c.agent)), new Set(["Avery", "Priya", "Eli", "Fiona"]));

  // Priya and Fiona ran at the same time (parallel delegation).
  const priya = calls.find((c) => c.agent === "Priya")!;
  const fiona = calls.find((c) => c.agent === "Fiona")!;
  assert.ok(priya.start < fiona.end && fiona.start < priya.end, "Priya and Fiona should overlap in time");

  // Team threads exist with both sides of each conversation.
  for (const [id, asker, answer] of [
    ["team:chief:pm", "chief", "Scope: 14 days, 3 seats."],
    ["team:pm:dev", "pm", "About 4 weeks."],
    ["team:chief:cfo", "chief", "Net positive at 9% conversion."],
  ] as const) {
    const t = s.threads[id];
    assert.ok(t, `${id} should exist`);
    assert.equal(t.messages[0].author, asker);
    assert.ok(t.messages.some((m) => m.text === answer), `${id} should contain the reply`);
    assert.equal(t.busy, false);
  }

  // The CEO sees the final recommendation in the DM, and nothing is left "working".
  const dm = s.threads["dm:chief"];
  assert.equal(dm.messages.at(-1)?.text, "Recommendation: launch the trial.");
  assert.ok(Object.values(s.threads).every((t) => !t.busy));

  // The task board got Priya's task.
  assert.equal(s.tasks.length, 1);
  assert.equal(s.tasks[0].owner, "dev");

  // Tool results come back in a single user message, matched to every tool_use id.
  const averyFollowUp = calls.filter((c) => c.agent === "Avery")[1].body.messages as { role: string; content: { type: string; tool_use_id?: string }[] }[];
  const results = averyFollowUp.at(-1)!;
  assert.equal(results.role, "user");
  assert.deepEqual(results.content.map((b) => b.type), ["tool_result", "tool_result"]);

  // Request shape: refusal fallback on, no manual thinking config, strict tools, depth limit respected.
  const first = calls[0];
  assert.equal(first.body.fallbacks, "default");
  assert.match(first.headers.get("anthropic-beta") ?? "", /server-side-fallback-2026-07-01/);
  assert.equal(first.body.thinking, undefined);
  // Prompt caching: automatic caching on the conversation plus a breakpoint on the static system prompt.
  assert.deepEqual(first.body.cache_control, { type: "ephemeral" });
  assert.deepEqual((first.body.system as { cache_control?: unknown }[])[0].cache_control, { type: "ephemeral" });
  assert.ok((first.body.tools as { strict?: boolean; type?: string }[]).filter((t) => !t.type).every((t) => t.strict));
  const eliTools = (calls.find((c) => c.agent === "Eli")!.body.tools as { name: string }[]).map((t) => t.name);
  assert.ok(!eliTools.includes("message_colleague"), "depth-2 agents can't delegate further");
  const priyaTargets = ((priya.body.tools as { name: string; input_schema?: { properties: { to?: { enum: string[] } } } }[])
    .find((t) => t.name === "message_colleague")!.input_schema!.properties.to!.enum);
  assert.deepEqual(priyaTargets, ["dev"], "below the top, agents delegate only to their direct reports");
  const fionaTools = (fiona.body.tools as { name: string }[]).map((t) => t.name);
  assert.ok(!fionaTools.includes("message_colleague"), "agents with no reports can't delegate when asked by a colleague");
});

test("a request stops itself when it reaches its budget", async () => {
  calls.length = 0;
  store.replaceWorkspace(
    store.freshWorkspace(cloneOrg(TEMPLATES[0]), { ...store.DEFAULT_SETTINGS, apiKey: "sk-ant-test", maxCostPerRequest: 0.0001 }),
  );

  await assert.rejects(sendFromCeo("chief", "Should we launch a free trial?"));
  const s = store.getState();

  // Avery's first reply already costs more than $0.0001, so nobody else gets called.
  assert.deepEqual(calls.map((c) => c.agent), ["Avery"]);
  const dm = s.threads["dm:chief"];
  assert.match(dm.messages.at(-1)?.text ?? "", /reached its \$0\.00 budget/);
  assert.ok(Object.values(s.threads).every((t) => !t.busy));

  // History stays valid for the next message: the dangling tool calls got error results.
  const last = dm.history.at(-1)!;
  assert.equal(last.role, "user");
  assert.ok(Array.isArray(last.content) && last.content.every((b) => b.type === "tool_result"));
});
