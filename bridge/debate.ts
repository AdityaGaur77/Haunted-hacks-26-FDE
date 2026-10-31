// One FDE Council debate: the 5 client agents debate a request over Agent Relay and the
// requesting client writes the plan. The SeminarActor holds the event log (source of truth);
// every event is also posted to the debate's Relay channel as the agent who said it.
import type { Actors, Approval, SeminarActor } from "./actors";
import type { Relay } from "./relay";
import type { Store } from "./store";
import { CLIENT_IDS, type AgentName, type ClientId, type Event, type EventType } from "./types";

export interface Deps {
  actors: Actors;
  relay: Relay;
  /** Supabase: where the final plan is saved (optional). */
  store?: Store;
}

export interface Debate {
  seminarId: string; // also the Relay channel name
  done: Promise<void>; // resolves when the plan is written (never rejects)
}

interface Context extends Deps {
  seminarId: string;
  seminar: SeminarActor;
  requester: ClientId;
  request: string;
  transcript: Event[]; // local copy, used only if the SeminarActor can't be read
  seenFde: Set<string>;
}

const TURN_TIMEOUT_MS = Number(process.env.ACTOR_TIMEOUT_MS ?? 90_000);
let lastSeminarTs = 0;

/** Creates the seminar and returns its id once the request is recorded; the rounds run in the background. */
export async function startDebate(deps: Deps, requester: ClientId, request: string): Promise<Debate> {
  lastSeminarTs = Math.max(Date.now(), lastSeminarTs + 1); // unique even for two debates in the same ms
  const seminarId = `seminar-${lastSeminarTs}`;
  const seminar = deps.actors.seminar(seminarId);
  // start() marks the seminar running and records the "request" event.
  const requestEvent = normalizeEvent(await seminar.start(requester, request), requester, ["request"]);

  const ctx: Context = { ...deps, seminarId, seminar, requester, request, transcript: [requestEvent], seenFde: new Set() };
  console.log(`\n=== ${seminarId}  (${deps.actors.kind} actors, Relay ${deps.relay.enabled ? `#${seminarId}` : "off"})`);
  printEvent(requestEvent);
  const done = runRounds(ctx, requestEvent).catch((error) =>
    console.error(`[${seminarId}] debate failed: ${errorMessage(error)}`),
  );
  return { seminarId, done };
}

/** The FDE jumps in: the event lands in the SeminarActor and is picked up before the next turn. */
export async function addFdeInput(actors: Actors, seminarId: string, text: string): Promise<Event> {
  const event: Event = { type: "fde", from: "fde", text, ts: Date.now() };
  await actors.seminar(seminarId).addEvent(event);
  return event;
}

async function runRounds(ctx: Context, requestEvent: Event) {
  const { actors, relay, seminarId, requester, request } = ctx;
  await relay.openChannel(seminarId, `${requester}: ${request}`.slice(0, 250));
  await relay.post(requester, seminarId, relayText(requestEvent), { event: requestEvent });

  const started = Date.now();

  // Each round runs its 5 agent calls in parallel; every event is published as soon as its call
  // finishes. The SeminarActor is read right before each round and the plan, so FDE input that
  // arrived during the previous round is included.

  // Round 1: everyone gives a take (or abstains), seeing the request plus any FDE input.
  const round1 = await readTranscript(ctx);
  await Promise.all(
    CLIENT_IDS.map((id) => turn(ctx, id, ["take", "abstain"], () => actors.client(id).respond(request, round1, seminarId))),
  );

  // Round 2: everyone challenges, each seeing the full round-1 transcript.
  const round2 = await readTranscript(ctx);
  await Promise.all(CLIENT_IDS.map((id) => turn(ctx, id, ["challenge"], () => actors.client(id).challenge(round2, seminarId))));

  // Plan, then FDE approval. A rejection's feedback lands in the transcript as an "fde" event,
  // so each rewrite (up to MAX_REWRITES) gets it as an FDE constraint.
  for (let rewrite = 0; rewrite <= MAX_REWRITES; rewrite++) {
    const transcript = await readTranscript(ctx);
    const fdeConstraints = transcript.filter((e) => e.type === "fde").map((e) => e.text);
    const planned = await turn(ctx, requester, ["plan"], () =>
      actors.client(requester).writePlan(transcript, fdeConstraints, seminarId),
    );
    if (!planned) {
      // Keep the UI from waiting forever: the frontend treats the "plan" event as the end of the debate.
      const text = "The plan could not be generated (see bridge logs). The debate above still stands.";
      await publish(ctx, { type: "plan", from: requester, text, ts: Date.now() });
      await ctx.seminar.markDone();
      return;
    }
    if (rewrite === 0) console.log(`[${seminarId}] request -> plan in ${((Date.now() - started) / 1000).toFixed(1)}s`);

    await ctx.seminar.requestApproval();
    console.log(`[${seminarId}] awaiting FDE approval: type "approve" or "reject: <feedback>" (or POST /seminar/${seminarId}/approve | /reject)`);
    const decision = await waitForDecision(ctx);
    if (decision.state === "approved") {
      await ctx.seminar.markDone();
      await onApproved(ctx);
      console.log(`=== ${seminarId} approved by the FDE\n`);
      return;
    }
    if (decision.state !== "rejected") {
      console.warn(`[${seminarId}] no FDE decision within ${approvalTimeoutMs() / 60_000} min; ending without saving the plan`);
      break;
    }
    console.log(`[${seminarId}] plan rejected${decision.feedback ? `: "${decision.feedback}"` : ""}`);
    if (rewrite === MAX_REWRITES) console.warn(`[${seminarId}] plan rejected ${MAX_REWRITES + 1} times; giving up`);
  }
  await ctx.seminar.markDone();
  console.log(`=== ${seminarId} ended without an approved plan\n`);
}

const MAX_REWRITES = 3;
const approvalTimeoutMs = () => Number(process.env.APPROVAL_TIMEOUT_MS ?? 10 * 60_000);
const approvalPollMs = () => Number(process.env.APPROVAL_POLL_MS ?? 1000);

/** Polls the SeminarActor until the FDE approves or rejects, or the timeout passes. */
async function waitForDecision(ctx: Context): Promise<Approval> {
  const deadline = Date.now() + approvalTimeoutMs();
  while (Date.now() < deadline) {
    await Bun.sleep(approvalPollMs());
    try {
      const approval = await ctx.seminar.getApproval();
      if (approval.state === "approved" || approval.state === "rejected") return approval;
    } catch (error) {
      console.warn(`[${ctx.seminarId}] could not read the approval state: ${errorMessage(error)}`);
    }
  }
  return { state: "pending" };
}

/** Only after approval: save the plan to Supabase and let the requester's memory learn from it. */
async function onApproved(ctx: Context) {
  await savePlan(ctx);
  const plan = ctx.transcript.findLast((e) => e.type === "plan" && e.from === ctx.requester);
  if (!plan) return;
  try {
    await ctx.actors.client(ctx.requester).remember({
      request: ctx.request,
      solution: plan.text,
      what_broke: "",
      fix: "",
      stack: "",
      outcome: "Approved by FDE",
    });
  } catch (error) {
    console.warn(`[${ctx.seminarId}] could not save the approved plan to ${ctx.requester}'s memory: ${errorMessage(error)}`);
  }
}

/**
 * Saves the approved plan to Supabase: only the sanitized plan, never memories. Fake plans are
 * skipped because they quote seed memories word for word. A save failure never fails the debate.
 */
async function savePlan(ctx: Context) {
  const { store, actors, seminarId, requester, request } = ctx;
  if (!store?.enabled || actors.kind !== "real") return;
  const plan = ctx.transcript.findLast((e) => e.type === "plan" && e.from === requester);
  if (!plan) return;
  try {
    await store.savePlan({ seminar_id: seminarId, client_id: requester, request, plan: plan.text, cites: plan.cites ?? [] });
  } catch (error) {
    console.warn(`[${seminarId}] could not save the plan to Supabase: ${errorMessage(error)}`);
  }
}

/** Reads the SeminarActor's log so agents see FDE input; new FDE events are printed and mirrored to Relay. */
async function readTranscript(ctx: Context): Promise<Event[]> {
  let events: Event[];
  try {
    events = await withTimeout(ctx.seminar.getEvents(), 15_000);
  } catch (error) {
    console.warn(`[${ctx.seminarId}] could not read the seminar, using the local transcript: ${errorMessage(error)}`);
    return [...ctx.transcript];
  }
  for (const event of events) {
    const key = `${event.ts}|${event.text}`;
    if (event.type !== "fde" || ctx.seenFde.has(key)) continue;
    ctx.seenFde.add(key);
    ctx.transcript.push(event);
    printEvent(event);
    await ctx.relay.post("fde", ctx.seminarId, relayText(event), { event });
  }
  return events;
}

/** One agent turn: call the actor (one retry), then publish its event. Returns false if it never answered. */
async function turn(ctx: Context, id: ClientId, allowed: EventType[], call: () => Promise<Event>): Promise<boolean> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const event = normalizeEvent(await withTimeout(call(), TURN_TIMEOUT_MS), id, allowed);
      await publish(ctx, event);
      return true;
    } catch (error) {
      console.error(`[${ctx.seminarId}] ${id} ${allowed.join("/")} failed (attempt ${attempt}/2): ${errorMessage(error)}`);
    }
  }
  return false;
}

async function publish(ctx: Context, event: Event) {
  await ctx.seminar.addEvent(event);
  ctx.transcript.push(event);
  printEvent(event);
  await ctx.relay.post(event.from, ctx.seminarId, relayText(event), { event });
}

/** Coerce whatever an actor returned into a valid Event from `from` (LLM output can be messy). */
export function normalizeEvent(raw: unknown, from: AgentName, allowed: EventType[]): Event {
  const r = (typeof raw === "object" && raw !== null ? raw : { text: raw }) as Record<string, unknown>;
  const type = allowed.includes(r.type as EventType) ? (r.type as EventType) : allowed[0]!;
  const text = typeof r.text === "string" ? r.text : JSON.stringify(r.text ?? raw ?? "");
  const cites = Array.isArray(r.cites) ? r.cites.map(String) : [];
  return { type, from, text, ...(cites.length ? { cites } : {}), ts: typeof r.ts === "number" ? r.ts : Date.now() };
}

function relayText(event: Event): string {
  const cites = event.cites?.length ? `\n(cites: ${event.cites.join("; ")})` : "";
  return `[${event.type}] ${event.text}${cites}`;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

// --- terminal output ---------------------------------------------------------------------

const COLORS: Record<string, number> = { "client-1": 36, "client-2": 32, "client-3": 35, "client-4": 33, "client-5": 34, fde: 31 };
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: number, text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const INDENT = " ".repeat(19);

export function printEvent(event: Event) {
  const from = String(event.from);
  const head = `${paint(COLORS[from] ?? 37, from.padEnd(8))} ${paint(1, String(event.type).toUpperCase().padEnd(9))}`;
  console.log(`${head} ${String(event.text).split("\n").join(`\n${INDENT}`)}`);
  if (event.cites?.length) console.log(INDENT + paint(2, `cites: ${event.cites.join("; ")}`));
}
