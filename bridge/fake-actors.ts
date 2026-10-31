// Fake actors: canned but realistic behaviour built from seed-data.json, so the whole debate runs
// end to end without the real actors. In-memory only; state is lost on restart.
// Output follows the real actors' conventions (actors/src/prompts.ts): short texts, no company
// names, `cites` lists agent ids, and the plan is numbered steps that credit an agent id.
//
// Each client looks for its most relevant memory (keyword match on the request), then:
//   round 1  -> "take" from that memory, or "abstain" if it has none
//   round 2  -> "challenge": clients whose approach broke warn the others; the requester reacts
//   plan     -> what worked + what broke (and how it was fixed) + all constraints
import type { Actors, Approval, ClientActor, SeminarActor } from "./actors";
import seedData from "./seed-data.json";
import type { AgentName, ClientId, ClientProfile, Event, EventType, Memory } from "./types";

type World = Map<ClientId, { profile: ClientProfile; memories: Memory[] }>;

export function createFakeActors(): Actors {
  const world: World = new Map();
  // Start pre-seeded so debates work without running seed.ts first.
  for (const { id, memories, ...profile } of seedData.clients) world.set(id as ClientId, { profile, memories });
  const seminars = new Map<string, Event[]>();
  const approvals = new Map<string, Approval>();
  return {
    kind: "fake",
    client: (id) => fakeClient(id, world),
    seminar: (id) => fakeSeminar(id, seminars, approvals),
    async prepareSeminarSocket(seminarId) {
      // Fakes have no live socket: poll GET /seminar/:id/events instead.
      return { websocketUrl: `ws://fake-actors.invalid/seminar/${seminarId}`, fake: true };
    },
  };
}

function fakeSeminar(id: string, seminars: Map<string, Event[]>, approvals: Map<string, Approval>): SeminarActor {
  const events = () => seminars.get(id) ?? seminars.set(id, []).get(id)!;
  return {
    async start(requestingClient, request) {
      const event: Event = { type: "request", from: requestingClient, text: request, ts: Date.now() };
      seminars.set(id, [event]);
      approvals.set(id, { state: "none" });
      return structuredClone(event);
    },
    async addEvent(event) {
      events().push(structuredClone(event));
    },
    async getEvents() {
      return structuredClone(events());
    },
    async markDone() {},
    async requestApproval() {
      approvals.set(id, { state: "pending" });
    },
    async getApproval() {
      return structuredClone(approvals.get(id) ?? { state: "none" });
    },
    // Same as the real SeminarActor: only acts on a pending plan, and both append an "fde" event.
    async approve() {
      if (approvals.get(id)?.state !== "pending") return;
      approvals.set(id, { state: "approved" });
      events().push({ type: "fde", from: "fde", text: "Approved the plan.", ts: Date.now() });
    },
    async reject(feedback) {
      if (approvals.get(id)?.state !== "pending") return;
      const text = feedback.trim() || "Rejected the plan. Revise it.";
      approvals.set(id, { state: "rejected", feedback: text });
      events().push({ type: "fde", from: "fde", text, ts: Date.now() });
    },
  };
}

function fakeClient(id: ClientId, world: World): ClientActor {
  const me = () => world.get(id)!;
  return {
    async seed(profile, memories) {
      world.set(id, { profile: structuredClone(profile), memories: structuredClone(memories) }); // replace, never append
      return memories.length;
    },

    async remember(memory) {
      me().memories.push(structuredClone(memory));
    },

    async respond(request, transcript) {
      await pace();
      const { profile, memories } = me();
      const match = relevantMemory(memories, request);
      if (requesterOf(transcript) === id) {
        const m = match?.memory;
        // An approved plan stored by remember() is the council's memory at work: say so.
        const history = !m
          ? " We haven't done this before."
          : m.outcome === "Approved by FDE"
            ? ` We've planned something close before, approved by the FDE ("${m.request}"): ${firstLine(m.solution)} Building on that.`
            : ` Closest thing we've done: ${lowerFirst(sentence(m.request))}`;
        const text = `This is our request. Our stack: ${profile.stack}. Constraints: ${profile.constraints.join("; ")}.${history}`;
        return event("take", id, text, transcript, match && [id]);
      }
      if (!match) {
        return event("abstain", id, `No relevant experience at this deployment (our stack: ${profile.stack}).`, transcript);
      }
      const m = match.memory;
      const lead = match.score >= 4 ? `We've done this (${m.stack}).` : `Closest thing we've done: ${lowerFirst(sentence(m.request))}`;
      const fix = smooth(m) ? "" : ` Fix: ${sentence(m.fix)}`;
      const text = `${lead} What we did: ${sentence(m.solution)} What broke: ${sentence(m.what_broke)}${fix}`;
      return event("take", id, text, transcript, [id]);
    },

    async challenge(transcript) {
      await pace();
      const { profile, memories } = me();
      const requester = requesterOf(transcript);
      const request = requestOf(transcript);
      // Other clients' takes; the requester's own take is context, not an approach to challenge.
      const others = transcript.filter((e) => e.type === "take" && e.from !== id && e.from !== requester);
      const warnings = others
        .map((e) => ({ from: e.from, memory: memoryOf(world, e.from, request) }))
        .filter((x) => x.memory && !smooth(x.memory));

      if (id === requester) {
        const ours = warnings
          .map((w) => ({ ...w, shared: sharedTech(w.memory!.stack, profile.stack) }))
          .filter((w) => w.shared.length)
          .sort((a, b) => b.shared.length - a.shared.length)[0]; // the warning closest to our stack
        if (ours) {
          const text = `@${ours.from}, that's our risk too: we also run ${ours.shared.join(", ")}. Whatever we copy has to include your fix.`;
          return event("challenge", id, text, transcript, [ours.from]);
        }
        const proven = others.filter((e) => !warnings.some((w) => w.from === e.from));
        const text = proven.length
          ? `Thanks. Unless someone objects, we'll follow ${mention(proven)}.`
          : "Thanks, all. Nobody has done exactly this, so we'll prototype carefully.";
        return event("challenge", id, text, transcript);
      }

      const match = relevantMemory(memories, request);
      if (!match) {
        return event("challenge", id, `Nothing to challenge from this deployment. Deferring to ${mention(others) || "the others"}.`, transcript);
      }
      const m = match.memory;
      if (!smooth(m)) {
        const text = `${mention(others) || `@${requester}`} careful before copying that approach as-is. ${sentence(m.what_broke)} What fixed it for us: ${sentence(m.fix)}`;
        return event("challenge", id, text, transcript, [id]);
      }
      if (warnings.length) {
        // Push back with our own memory: this is where the council disagrees.
        const text = `I disagree with ${mention(warnings)}: what we did just worked (${m.stack}). ${sentence(m.what_broke)} ${sentence(m.outcome)}`;
        return event("challenge", id, text, transcript, [id]);
      }
      return event("challenge", id, `No objections. Our experience matches: ${sentence(m.outcome)}`, transcript, [id]);
    },

    async writePlan(transcript, fdeConstraints) {
      await pace();
      const { profile } = me();
      const request = requestOf(transcript);
      // Every agent cited by someone else's take or challenge, with the memory it was citing.
      const cited = new Map<ClientId, Memory>();
      for (const e of transcript) {
        if ((e.type !== "take" && e.type !== "challenge") || e.from === id) continue;
        for (const agent of e.cites ?? []) {
          const memory = memoryOf(world, agent, request);
          if (memory && agent !== id) cited.set(agent as ClientId, memory);
        }
      }
      const proven = [...cited].filter(([, m]) => smooth(m));
      const risks = [...cited].filter(([, m]) => !smooth(m));
      // Risks that hit our own stack come first.
      risks.sort(([, a], [, b]) => sharedTech(b.stack, profile.stack).length - sharedTech(a.stack, profile.stack).length);

      const steps = [
        ...proven.map(([agent, m]) => `Do what worked: ${lowerFirst(sentence(m.solution))} (${agent})`),
        ...risks.map(([agent, m]) => {
          const shared = sharedTech(m.stack, profile.stack);
          const applies = shared.length ? ` We also run ${shared.join(", ")}, so this applies to us.` : "";
          return `Avoid what broke: ${lowerFirst(sentence(firstSentence(m.what_broke)))} Fix: ${lowerFirst(sentence(m.fix))}${applies} (${agent})`;
        }),
        `Stay within our constraints: ${profile.constraints.join("; ")}. (${id})`,
        ...(fdeConstraints.length ? [`FDE constraints: ${fdeConstraints.join("; ")}. (fde)`] : []),
      ];
      if (!proven.length && !risks.length) steps.unshift("Nobody on the council has done this: start with a small spike behind a feature flag.");
      const text = [`Plan for ${id}: ${request}`, ...steps.map((s, i) => `${i + 1}. ${s}`)].join("\n");
      return { type: "plan", from: id, text, ...(cited.size ? { cites: [...cited.keys()] } : {}), ts: Date.now() };
    },
  };
}

// --- helpers -----------------------------------------------------------------------------

function event(type: EventType, from: ClientId, text: string, transcript: Event[], cites?: string[]): Event {
  const fde = transcript.filter((e) => e.type === "fde").at(-1);
  if (fde && asksForPrivateDetails(fde.text)) {
    // Same rule as the real agents: lessons may leave a deployment; code and client details never do.
    const refusal = `I can't share another deployment's code, configuration or client details; each client's data stays inside its own agent. The shareable lesson is above.`;
    return { type, from, text: `${text} ${refusal}`, ...(cites?.length ? { cites } : {}), ts: Date.now() };
  }
  const note = fde ? ` (Taking the FDE's note into account: "${fde.text}")` : "";
  return { type, from, text: text + note, ...(cites?.length ? { cites } : {}), ts: Date.now() };
}

/** "Share client-5's exact code / config / file / credentials" and similar. */
const asksForPrivateDetails = (text: string) =>
  /\b(code|snippet|source|config(uration)?|files?|credentials?|keys?|secrets?|customer data|exact implementation)\b/i.test(text) &&
  /\b(share|send|give|show|paste|copy)\b/i.test(text);

const firstLine = (s: string) => sentence(s.split("\n").find((l) => /^\d+\./.test(l.trim()))?.replace(/^\s*\d+\.\s*/, "") ?? s.split("\n")[0] ?? s);

const requesterOf = (transcript: Event[]) => transcript.find((e) => e.type === "request")?.from;
const requestOf = (transcript: Event[]) => transcript.find((e) => e.type === "request")?.text ?? "";
const mention = (xs: { from: AgentName }[]) => xs.map((x) => `@${x.from}`).join(" ");
const smooth = (m: Memory) => /^(nothing|none|no )/i.test(m.what_broke.trim());
const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);
const firstSentence = (s: string) => s.split(/(?<=[.!?])\s/)[0] ?? s;
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** The memory an agent would draw on for this request (what its take was based on). */
const memoryOf = (world: World, agent: string, request: string) =>
  relevantMemory(world.get(agent as ClientId)?.memories ?? [], request)?.memory;

/** First word of each comma-separated stack item, e.g. "React, Vite, ECharts (x)" -> React, Vite, ECharts. */
const tech = (stack: string) => stack.split(/[,;]/).map((s) => s.trim().split(/[\s(]/)[0]!).filter(Boolean);
function sharedTech(theirStack: string, ourStack: string): string[] {
  const ours = tech(ourStack).map((t) => t.toLowerCase());
  return tech(theirStack).filter((t) => ours.includes(t.toLowerCase()));
}

const STOPWORDS = new Set(["add", "the", "and", "for", "with", "our", "your", "you", "can", "please", "want", "need", "new", "make", "let", "get", "use", "from", "into", "this", "that", "support", "show", "allow", "enable", "build", "create", "improve", "update"]);
const SYNONYMS: Record<string, string[]> = {
  dark: ["theme"],
  night: ["dark", "theme"],
  theme: ["dark"],
  theming: ["theme"],
  sso: ["sign-on", "saml"],
  login: ["sign-on", "auth"],
  "2fa": ["two-factor"],
  mfa: ["two-factor"],
  slow: ["speed"],
  performance: ["speed", "load time"],
  accessibility: ["accessib", "screen reader"],
  a11y: ["accessib", "screen reader"],
};

function keywords(text: string): string[] {
  const words = (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
  return [...new Set(words.flatMap((w) => [w, ...(SYNONYMS[w] ?? [])]))];
}

/** Best memory for a request: keyword hits in the memory's request count double. Needs a score of 2+. */
function relevantMemory(memories: Memory[], request: string) {
  // Match at word starts: "theme" hits "themes", but "live" doesn't hit "delivery".
  const keys = keywords(request).map((k) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"));
  let best: { memory: Memory; score: number } | undefined;
  for (const memory of memories) {
    const title = memory.request;
    const body = `${memory.solution} ${memory.stack} ${memory.what_broke} ${memory.fix}`;
    const score = keys.reduce((sum, k) => sum + (k.test(title) ? 2 : k.test(body) ? 1 : 0), 0);
    if (score >= 2 && score > (best?.score ?? 0)) best = { memory, score };
  }
  return best;
}

/** Make the fake debate look live. FAKE_DELAY_MS=0 disables it (tests). */
async function pace() {
  const ms = Number(process.env.FAKE_DELAY_MS ?? 700);
  if (ms > 0) await Bun.sleep(ms * (0.5 + Math.random()));
}
