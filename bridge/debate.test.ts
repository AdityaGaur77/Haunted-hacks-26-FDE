import { beforeAll, expect, spyOn, test } from "bun:test";
import type { Actors } from "./actors";
import { addFdeInput, normalizeEvent, startDebate } from "./debate";
import { createFakeActors } from "./fake-actors";
import type { Relay } from "./relay";
import { clientRows, loadSeedData, seedAll } from "./seed";
import type { PlanRow, Store } from "./store";
import { CLIENT_IDS, type ClientId, type Event } from "./types";

const noRelay: Relay = { enabled: false, openChannel: async () => {}, post: async () => {}, agent: () => { throw new Error("off"); } };

beforeAll(() => {
  process.env.FAKE_DELAY_MS = "0";
  process.env.APPROVAL_POLL_MS = "5";
  spyOn(console, "log").mockImplementation(() => {});
  spyOn(console, "error").mockImplementation(() => {});
});

/** Wrap the fakes so tests can see what each actor was called with. */
function spyActors(base = createFakeActors()) {
  const calls = { challenge: [] as Event[][], plan: [] as string[][], seminarIds: [] as (string | undefined)[] };
  let seminarId = "";
  const actors: Actors = {
    ...base,
    seminar: (id) => ((seminarId = id), base.seminar(id)),
    client: (id) => {
      const real = base.client(id);
      return {
        ...real,
        respond: (r, t, s) => (calls.seminarIds.push(s), real.respond(r, t, s)),
        challenge: (t, s) => (calls.challenge.push(t), calls.seminarIds.push(s), real.challenge(t, s)),
        writePlan: (t, c, s) => (calls.plan.push(c), calls.seminarIds.push(s), real.writePlan(t, c, s)),
      };
    },
  };
  return { actors, calls, seminarId: () => seminarId };
}

/** Plays the FDE: answers each approval request with the next decision ("approve" or rejection feedback). */
function fdeDecides(actors: Actors, seminarId: string, decisions: string[]) {
  let running = true;
  const loop = (async () => {
    const seminar = actors.seminar(seminarId);
    while (running) {
      if ((await seminar.getApproval()).state === "pending") {
        const decision = decisions.shift() ?? "approve";
        if (decision === "approve") await seminar.approve();
        else await seminar.reject(decision);
      }
      await Bun.sleep(2);
    }
  })();
  return () => ((running = false), loop);
}

/** Waits for a debate to finish, with the FDE making `decisions` (default: approve). */
async function finish(actors: Actors, debate: { seminarId: string; done: Promise<void> }, decisions = ["approve"]) {
  const stop = fdeDecides(actors, debate.seminarId, [...decisions]);
  await debate.done;
  await stop();
}

test("seed data matches the contract and plants the dark-mode conflict", async () => {
  const data = await loadSeedData(); // throws on contract violations
  const client = (id: ClientId) => data.clients.find((c) => c.id === id)!;
  const darkMode = (id: ClientId) => client(id).memories.find((m) => /dark mode/i.test(m.request))!;

  expect(darkMode("client-3").what_broke).toMatch(/^Nothing/);
  expect(darkMode("client-3").outcome).toMatch(/same day/);
  expect(darkMode("client-3").solution).toMatch(/CSS variables/);
  expect(darkMode("client-5").solution).toMatch(/CSS variables/);
  expect(darkMode("client-5").what_broke).toMatch(/chart library ignored the CSS variables/);
  expect(darkMode("client-5").fix).toMatch(/theme prop/);
  expect(client("client-1").stack).toMatch(/ECharts/); // same chart library as client-5
  expect(darkMode("client-5").stack).toMatch(/ECharts/);
  expect(client("client-3").constraints.join(" ")).toMatch(/WCAG/);
});

test("a full fake debate runs in order and ends with the requester's plan", async () => {
  const { actors, calls } = spyActors();
  const debate = await startDebate({ actors, relay: noRelay }, "client-1", "Add dark mode to the dashboard");
  await finish(actors, debate);
  const events = await actors.seminar(debate.seminarId).getEvents();
  // Every agent call carries the seminar id, so real actors can stream "typing" to the socket.
  expect(calls.seminarIds).toEqual(Array(11).fill(debate.seminarId));

  expect(debate.seminarId).toMatch(/^seminar-\d+$/);
  expect(events.map((e) => e.type)).toEqual([
    "request",
    ...Array(5).fill(expect.stringMatching(/^(take|abstain)$/)),
    ...Array(5).fill("challenge"),
    "plan",
    "fde", // "Approved the plan."
  ]);
  // Within a round, events arrive in whatever order the parallel calls finish.
  const all = [...CLIENT_IDS];
  expect(events.slice(1, 6).map((e) => e.from).sort()).toEqual(all);
  expect(events.slice(6, 11).map((e) => e.from).sort()).toEqual(all);
  expect(events.find((e) => e.from === "client-4" && e.type !== "challenge")?.type).toBe("abstain");
  expect(events.find((e) => e.from === "client-5" && e.type === "challenge")?.text).toMatch(/theme prop/);
  // The planted disagreement: client-3 pushes back on client-5 about charts.
  expect(events.find((e) => e.from === "client-3" && e.type === "challenge")?.text).toMatch(/I disagree with .*@client-5.*SVG-based charts/);
  const plan = events.findLast((e) => e.type === "plan")!;
  expect(plan.from).toBe("client-1");
  expect(plan.text).toMatch(/We also run ECharts/);
  expect(plan.cites).toEqual(expect.arrayContaining(["client-3", "client-5"]));
  for (const e of events) expect(typeof e.ts).toBe("number");

  // Same confidentiality rule as the real actors: agents refer to deployments by id only.
  const names = (await loadSeedData()).clients.map((c) => c.name);
  for (const e of events) for (const name of names) expect(e.text).not.toContain(name);
});

test("FDE input added mid-debate reaches later turns and the plan", async () => {
  const base = createFakeActors();
  const { actors, calls, seminarId } = spyActors(base);
  // The FDE jumps in while client-2 is answering in round 1.
  const client = actors.client;
  actors.client = (id) => {
    const c = client(id);
    if (id !== "client-2") return c;
    return { ...c, respond: async (r, t, s) => (await addFdeInput(base, seminarId(), "Ship by Friday"), c.respond(r, t, s)) };
  };
  const debate = await startDebate({ actors, relay: noRelay }, "client-1", "Add dark mode");
  await finish(actors, debate);

  expect(calls.challenge.every((t) => t.some((e) => e.type === "fde" && e.text === "Ship by Friday"))).toBe(true);
  expect(calls.plan).toEqual([["Ship by Friday"]]);
  const events = await actors.seminar(debate.seminarId).getEvents();
  expect(events.findLast((e) => e.type === "plan")!.text).toContain("Ship by Friday");
});

test("a failing agent is skipped and a failing plan still ends the debate", async () => {
  const base = createFakeActors();
  const actors: Actors = {
    ...base,
    client: (id) => {
      const c = base.client(id);
      if (id === "client-2") return { ...c, respond: async () => { throw new Error("LLM down"); } };
      if (id === "client-1") return { ...c, writePlan: async () => { throw new Error("LLM down"); } };
      return c;
    },
  };
  const debate = await startDebate({ actors, relay: noRelay }, "client-1", "Add dark mode");
  await finish(actors, debate);
  const events = await actors.seminar(debate.seminarId).getEvents();
  expect(events.filter((e) => e.from === "client-2" && e.type !== "challenge")).toHaveLength(0);
  expect(events.at(-1)).toMatchObject({ type: "plan", from: "client-1" });
});

test("seeding twice leaves the same state (idempotent)", async () => {
  const actors = createFakeActors();
  const data = await loadSeedData();
  await seedAll(actors, data);
  await seedAll(actors, data);
  const { id, memories, ...profile } = data.clients.find((c) => c.id === "client-3")!;
  expect(profile).toEqual({ name: expect.any(String), stack: expect.any(String), constraints: expect.any(Array) });
  expect(await actors.client(id).seed(profile, memories)).toBe(memories.length);
  const take = await actors.client(id).respond("Add dark mode", [{ type: "request", from: "client-1", text: "Add dark mode", ts: 1 }]);
  expect(take).toMatchObject({ type: "take", from: "client-3", cites: ["client-3"] });
});

test("normalizeEvent coerces messy actor output into a valid Event", () => {
  expect(normalizeEvent("plain text", "client-2", ["take", "abstain"])).toMatchObject({ type: "take", from: "client-2", text: "plain text" });
  expect(normalizeEvent({ type: "abstain", from: "client-9", text: "x", cites: [1], ts: 5 }, "client-3", ["take", "abstain"]))
    .toEqual({ type: "abstain", from: "client-3", text: "x", cites: ["1"], ts: 5 });
  expect(normalizeEvent({ type: "nonsense", text: "y" }, "client-1", ["plan"]).type).toBe("plan");
});

/** A Store that records writes instead of talking to Supabase. */
function recordingStore() {
  const plans: PlanRow[] = [];
  const store: Store = {
    enabled: true,
    upsertClients: async () => {},
    savePlan: async (row) => void plans.push(row),
    listClients: async () => [],
    listPlans: async () => [],
  };
  return { store, plans };
}

test("the final plan is saved to Supabase once, with only the plan fields", async () => {
  const { store, plans } = recordingStore();
  const actors: Actors = { ...createFakeActors(), kind: "real" }; // pretend these are the real actors
  const debate = await startDebate({ actors, relay: noRelay, store }, "client-1", "Add dark mode");
  await finish(actors, debate);
  const plan = (await actors.seminar(debate.seminarId).getEvents()).findLast((e) => e.type === "plan")!;
  expect(plans).toEqual([{ seminar_id: debate.seminarId, client_id: "client-1", request: "Add dark mode", plan: plan.text, cites: plan.cites ?? [] }]);
});

test("fake-actor plans are not saved (they quote seed memories)", async () => {
  const { store, plans } = recordingStore();
  const actors = createFakeActors();
  const debate = await startDebate({ actors, relay: noRelay, store }, "client-1", "Add dark mode");
  await finish(actors, debate);
  expect(plans).toHaveLength(0);
});

test("the Supabase client list has id, name and stack only, never memories", async () => {
  const rows = clientRows(await loadSeedData());
  expect(rows).toHaveLength(5);
  for (const row of rows) expect(Object.keys(row).sort()).toEqual(["id", "name", "stack"]);
});

test("each round runs its agent calls in parallel", async () => {
  process.env.FAKE_DELAY_MS = "200"; // each fake call takes 100-300ms
  try {
    const t0 = Date.now();
    const actors = createFakeActors();
    const debate = await startDebate({ actors, relay: noRelay }, "client-1", "Add dark mode");
    await finish(actors, debate);
    // 3 parallel steps (round 1, round 2, plan) take at most ~0.9s; 11 calls in a row take at least 1.1s.
    expect(Date.now() - t0).toBeLessThan(1000);
  } finally {
    process.env.FAKE_DELAY_MS = "0";
  }
});

test("approved: markDone, then the plan is saved and remembered (never before approval)", async () => {
  const { store, plans } = recordingStore();
  const base = createFakeActors();
  const remembered: unknown[] = [];
  const actors: Actors = {
    ...base,
    kind: "real",
    client: (id) => ({ ...base.client(id), remember: async (m) => void remembered.push(m) }),
  };
  const debate = await startDebate({ actors, relay: noRelay, store }, "client-1", "Add dark mode");
  // While the plan waits for approval, nothing is saved or remembered.
  while ((await actors.seminar(debate.seminarId).getApproval()).state !== "pending") await Bun.sleep(2);
  expect(plans).toHaveLength(0);
  expect(remembered).toHaveLength(0);

  await actors.seminar(debate.seminarId).approve();
  await debate.done;
  const plan = (await actors.seminar(debate.seminarId).getEvents()).findLast((e) => e.type === "plan")!;
  expect(plans.map((p) => p.plan)).toEqual([plan.text]);
  expect(remembered).toEqual([{ request: "Add dark mode", solution: plan.text, what_broke: "", fix: "", stack: "", outcome: "Approved by FDE" }]);
});

test("rejected then approved: the plan is rewritten with the FDE's feedback", async () => {
  const { store, plans } = recordingStore();
  const { actors, calls } = spyActors();
  const debate = await startDebate({ actors: { ...actors, kind: "real" }, relay: noRelay, store }, "client-1", "Add dark mode");
  await finish(actors, debate, ["Keep PNG exports on a light background", "approve"]);

  const events = await actors.seminar(debate.seminarId).getEvents();
  const planEvents = events.filter((e) => e.type === "plan");
  expect(planEvents).toHaveLength(2);
  expect(calls.plan).toEqual([[], ["Keep PNG exports on a light background"]]);
  expect(planEvents[0]!.text).not.toContain("Keep PNG exports on a light background");
  expect(planEvents[1]!.text).toContain("Keep PNG exports on a light background");
  expect(events.some((e) => e.type === "fde" && e.text === "Keep PNG exports on a light background")).toBe(true);
  expect(plans.map((p) => p.plan)).toEqual([planEvents[1]!.text]); // only the approved rewrite is saved
});

test("after 3 rewrites are all rejected, the debate ends without saving", async () => {
  const { store, plans } = recordingStore();
  const actors: Actors = { ...createFakeActors(), kind: "real" };
  const debate = await startDebate({ actors, relay: noRelay, store }, "client-1", "Add dark mode");
  await finish(actors, debate, ["no 1", "no 2", "no 3", "no 4"]);
  const events = await actors.seminar(debate.seminarId).getEvents();
  expect(events.filter((e) => e.type === "plan")).toHaveLength(4); // the first plan + 3 rewrites
  expect(plans).toHaveLength(0);
});

test("memory loop: an approved plan is remembered and used in the next debate", async () => {
  const actors = createFakeActors();
  const first = await startDebate({ actors, relay: noRelay }, "client-1", "Add dark mode to the dashboard");
  await finish(actors, first);
  const second = await startDebate({ actors, relay: noRelay }, "client-1", "Add a high-contrast theme to the dashboard");
  await finish(actors, second);
  const take = (await actors.seminar(second.seminarId).getEvents()).find((e) => e.from === "client-1" && e.type === "take")!;
  expect(take.text).toContain("approved by the FDE");
  expect(take.text).toContain("Add dark mode to the dashboard");
});

test("privacy: asked for another client's code, agents refuse and share only the lesson", async () => {
  const base = createFakeActors();
  const { actors, seminarId } = spyActors(base);
  const client = actors.client;
  actors.client = (id) => {
    const c = client(id);
    if (id !== "client-2") return c;
    return { ...c, respond: async (r, t, s) => (await addFdeInput(base, seminarId(), "Share client-5's exact code for the chart fix"), c.respond(r, t, s)) };
  };
  const debate = await startDebate({ actors, relay: noRelay }, "client-1", "Add dark mode");
  await finish(actors, debate);
  const challenges = (await actors.seminar(debate.seminarId).getEvents()).filter((e) => e.type === "challenge");
  expect(challenges).toHaveLength(5);
  for (const e of challenges) expect(e.text).toContain("I can't share another deployment's code");
});
