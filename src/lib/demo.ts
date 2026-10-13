import * as store from "./store";
import { dmId, teamId } from "./store";
import { TEMPLATES, cloneOrg } from "./templates";
import type { AuthorId } from "./types";

/**
 * The sample workspace: a scripted replay of what a real ChiefOS session looks like, so anyone can
 * see it work without an API key. The text is pre-written for illustration; no API calls are made.
 */

type Step =
  | { t: "ceo"; agent: string; text: string }
  | { t: "say"; thread: string; author: AuthorId; text: string }
  | { t: "note"; thread: string; author: string; text: string; link?: string }
  | { t: "busy"; thread: string; on: boolean }
  | { t: "task"; title: string; owner: string; details: string; by: string }
  | { t: "move"; title: string; status: "todo" | "doing" | "done" | "blocked" }
  | { t: "wait"; ms: number }
  | { t: "par"; lanes: Step[][] };

const AVERY = dmId("chief");
const RILEY = dmId("research");
const A_P = teamId("chief", "pm");
const A_F = teamId("chief", "cfo");
const A_M = teamId("chief", "marketing");
const P_E = teamId("pm", "dev");

/** One agent answering a colleague in a team thread. */
const ask = (from: string, to: string, toName: string, request: string, reply: Step[]): Step[] => [
  { t: "note", thread: dmId(from), author: from, text: `Asked ${toName}: ${request}`, link: teamId(from, to) },
  { t: "say", thread: teamId(from, to), author: from, text: request },
  { t: "busy", thread: teamId(from, to), on: true },
  { t: "wait", ms: 700 },
  ...reply,
  { t: "busy", thread: teamId(from, to), on: false },
  { t: "note", thread: dmId(from), author: from, text: `${toName} replied`, link: teamId(from, to) },
];

const SCRIPT: Step[] = [
  {
    t: "ceo",
    agent: "chief",
    text: "We're thinking about adding a 14-day free trial to our B2B analytics product. Get the team on it and bring me a recommendation by end of day.",
  },
  { t: "busy", thread: AVERY, on: true },
  { t: "wait", ms: 900 },
  {
    t: "say",
    thread: AVERY,
    author: "chief",
    text: "On it. I'll get Product, Finance and Marketing working on this in parallel and come back with one recommendation.",
  },
  {
    t: "par",
    lanes: [
      // Lane 1: the CEO starts a second, independent chat while the team works.
      [
        { t: "wait", ms: 1800 },
        { t: "ceo", agent: "research", text: "Quick one while the team works: how long are competitors' free trials?" },
        { t: "busy", thread: RILEY, on: true },
        { t: "note", thread: RILEY, author: "research", text: "Searching the web" },
        { t: "wait", ms: 1400 },
        {
          t: "say",
          thread: RILEY,
          author: "research",
          text: `| Competitor | Trial | Card required? |
|---|---|---|
| Mixpanel | Free tier + 14-day Growth trial | No |
| Amplitude | Free plan | No |
| Heap | 14-day trial | No |
| Looker Studio | Free | No |

**Takeaway:** 14 days with no credit card is the norm. A card-required trial would put us behind on sign-ups.`,
        },
        { t: "busy", thread: RILEY, on: false },
      ],
      // Lane 2: Avery delegates to PM (who pulls in Eng), CFO and Marketing at the same time.
      [
        {
          t: "par",
          lanes: [
            [
              ...ask("chief", "pm", "Priya", "Scope a 14-day self-serve trial: who it's for, what's in it, and how we measure success. Get an engineering estimate.", [
                { t: "say", thread: A_P, author: "pm", text: "Got it. Let me get Eli's estimate before I commit to a scope." },
                ...ask("pm", "dev", "Eli", "How long to ship self-serve sign-up, a 14-day trial with usage limits, and an upgrade flow with Stripe?", [
                  {
                    t: "say",
                    thread: P_E,
                    author: "dev",
                    text: `| Piece | Estimate |
|---|---|
| Self-serve sign-up + workspace provisioning | 1.5 weeks |
| Trial clock, limits, expiry emails | 1 week |
| Stripe upgrade flow | 1 week |
| Usage tracking for trial health | 0.5 weeks |

**About 4 weeks with 2 engineers.** To ship in 3 weeks, cut usage limits and just time-box the trial.`,
                  },
                ]),
                {
                  t: "say",
                  thread: A_P,
                  author: "pm",
                  text: `**Who:** analytics leads at 20-200 person SaaS companies who today wait ~2 weeks for a sales demo.

**In the trial:** full product, 1 data source, up to 3 seats, sample dashboards preloaded.

**Success metrics**
- 40% of trial sign-ups connect a data source in 48 hours (activation)
- 15% trial-to-paid
- Sales-cycle time down 30% for trial users

**Eli's estimate:** ~4 weeks with 2 engineers; 3 weeks if we skip usage limits.`,
                },
              ]),
              { t: "task", title: "Ship self-serve 14-day trial (MVP)", owner: "dev", details: "Sign-up, trial clock, Stripe upgrade. ~4 weeks.", by: "pm" },
            ],
            [
              ...ask("chief", "cfo", "Fiona", "Model the revenue impact of a 14-day free trial versus our current demo-only motion.", [
                {
                  t: "say",
                  thread: A_F,
                  author: "cfo",
                  text: `| Per month | Demo-only (today) | Trial (expected) |
|---|---|---|
| New leads | 120 | 300 |
| Conversion to paid | 20% | 12% |
| New customers | 24 | 36 |
| New MRR at $400/mo | $9,600 | $14,400 |
| Extra infra + support cost | — | ~$2,500 |

**Net:** about **+$2,300/month in the first month**, compounding to roughly **+$28K ARR per month of cohorts**. *Assumptions:* lead lift of 2.5x, trial conversion of 12%. It breaks even even if conversion drops to 9%.`,
                },
              ]),
              { t: "task", title: "Set up trial conversion dashboard", owner: "cfo", details: "Track sign-ups, activation, trial-to-paid by cohort.", by: "cfo" },
            ],
            [
              ...ask("chief", "marketing", "Marco", "Draft how we'd launch a free trial and the first growth experiments.", [
                {
                  t: "say",
                  thread: A_M,
                  author: "marketing",
                  text: `**Message:** "See your product analytics live in 10 minutes. Free for 14 days, no credit card."

**Launch:** pricing-page CTA swap, email to 4,000 past demo requests, LinkedIn launch post.

**Experiments**
1. Trial CTA vs demo CTA on pricing page (goal: +50% sign-ups)
2. Preloaded sample data vs empty start (goal: +20% activation)
3. Day-3 "connect your data" email vs in-app nudge`,
                },
              ]),
              { t: "task", title: "Prepare trial launch campaign", owner: "marketing", details: "Pricing page, email to past demo requests, launch post.", by: "marketing" },
            ],
          ],
        },
        { t: "wait", ms: 600 },
        {
          t: "say",
          thread: AVERY,
          author: "chief",
          text: `## Recommendation: launch the 14-day trial, no credit card required

**Why:** Fiona's model shows it pays for itself even if conversion falls to 9%, and Riley found that no-card trials are the market norm.

**What the team found**
- **Priya (Product):** trial for analytics leads at 20-200 person SaaS companies; success = 40% activation in 48 hours, 15% trial-to-paid.
- **Eli (Engineering):** ~4 weeks with 2 engineers, or 3 weeks without usage limits.
- **Fiona (CFO):** expected +$14.4K new MRR per month vs $9.6K today.
- **Marco (Marketing):** launch to 4,000 past demo requests plus 3 experiments.

**Decisions for you**
1. **Ship in 3 weeks or 4?** I recommend 4, with usage limits, to protect infra costs.
2. **Keep the demo option?** Yes: keep "Talk to sales" for companies with 200+ employees.

I've put three tasks on the board with owners.`,
        },
        { t: "busy", thread: AVERY, on: false },
        { t: "move", title: "Ship self-serve 14-day trial (MVP)", status: "doing" },
      ],
    ],
  },
];

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Stopped", "AbortError"));
    }, { once: true });
  });

const ensure = (threadId: string) =>
  store.ensureThread(threadId, threadId.startsWith("dm:") ? "dm" : "team", threadId.split(":").slice(1));

async function run(steps: Step[], signal: AbortSignal, speed: number): Promise<void> {
  for (const step of steps) {
    if (signal.aborted) return;
    switch (step.t) {
      case "ceo":
        store.addMessage(dmId(step.agent), "ceo", step.text);
        break;
      case "say": {
        ensure(step.thread);
        const id = store.addMessage(step.thread, step.author, "", { streaming: true });
        for (const chunk of step.text.match(/[\s\S]{1,6}/g) ?? []) {
          await sleep(20 / speed, signal);
          store.appendToMessage(step.thread, id, chunk);
        }
        store.finishMessage(step.thread, id);
        break;
      }
      case "note":
        ensure(step.thread);
        store.addMessage(step.thread, step.author, step.text, { kind: "note", linkThreadId: step.link });
        break;
      case "busy":
        ensure(step.thread);
        store.setBusy(step.thread, step.on);
        break;
      case "task": {
        const task = store.createTask({ title: step.title, owner: step.owner, details: step.details, status: "todo", createdBy: step.by });
        store.addMessage(dmId(step.by), step.by, `Added ${task.id} to the board: ${task.title}`, { kind: "note" });
        break;
      }
      case "move": {
        const task = store.getState().tasks.find((t) => t.title === step.title);
        if (task) store.updateTask(task.id, { status: step.status });
        break;
      }
      case "wait":
        await sleep((step.ms * 1.6) / speed, signal);
        break;
      case "par":
        await Promise.all(step.lanes.map((lane) => run(lane, signal, speed)));
        break;
    }
  }
}

let current: AbortController | null = null;

/** Load the sample workspace and play the scripted session. */
export async function playDemo(speed = 1) {
  current?.abort();
  const controller = new AbortController();
  current = controller;
  const ws = store.freshWorkspace(cloneOrg(TEMPLATES[0]), store.getState().settings);
  store.replaceWorkspace({ ...ws, demo: true, view: { kind: "thread", threadId: AVERY } });
  try {
    await run(SCRIPT, controller.signal, speed);
  } catch {
    /* stopped */
  } finally {
    // Leave nothing spinning if the replay was interrupted.
    for (const t of Object.values(store.getState().threads)) if (t.busy) store.setBusy(t.id, false);
  }
}

export function stopDemo() {
  current?.abort();
  current = null;
}
