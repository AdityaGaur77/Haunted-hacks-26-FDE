// Fake actors: canned but realistic behaviour built from seed-data.json, so the whole debate runs
// end to end without the real Terse actors. In-memory only; state is lost on restart.
//
// Each client looks for its most relevant memory (keyword match on the request), then:
//   round 1  -> "take" citing that memory, or "abstain" if it has none
//   round 2  -> "challenge": clients whose approach broke warn the others; the requester reacts
//   plan     -> approach from smooth experiences + risks from broken ones + all constraints
import type { Actors, ClientActor, SeminarActor } from "./actors";
import seedData from "./seed-data.json";
import type { AgentName, ClientId, ClientProfile, Event, EventType, Memory } from "./types";

type World = Map<ClientId, { profile: ClientProfile; memories: Memory[] }>;

export function createFakeActors(): Actors {
  const world: World = new Map();
  // Start pre-seeded so debates work without running seed.ts first.
  for (const { memories, ...profile } of seedData.clients) {
    world.set(profile.id as ClientId, { profile: profile as ClientProfile, memories });
  }
  const seminars = new Map<string, Event[]>();
  return {
    kind: "fake",
    client: (id) => fakeClient(id, world),
    seminar: (id) => fakeSeminar(id, seminars),
    async prepareSeminarSocket(seminarId) {
      // Fakes have no live socket: poll GET /seminar/:id/events instead.
      return { websocketUrl: `ws://fake-actors.invalid/seminar/${seminarId}`, fake: true };
    },
  };
}

function fakeSeminar(id: string, seminars: Map<string, Event[]>): SeminarActor {
  const events = () => seminars.get(id) ?? seminars.set(id, []).get(id)!;
  return {
    async addEvent(event) {
      events().push(structuredClone(event));
    },
    async getEvents() {
      return structuredClone(events());
    },
    async markDone() {},
  };
}

function fakeClient(id: ClientId, world: World): ClientActor {
  const me = () => world.get(id)!;
  return {
    async seed(profile, memories) {
      world.set(id, { profile: { ...profile, id }, memories: structuredClone(memories) }); // replace, never append
    },

    async respond(request, transcript) {
      await pace();
      const { profile, memories } = me();
      const match = relevantMemory(memories, request);
      if (requesterOf(transcript) === id) {
        const history = match
          ? ` Closest thing we've done: "${match.memory.request}" (${match.memory.outcome}).`
          : " We haven't done this before, so we're counting on the council.";
        const text = `This is our request. Context: ${profile.name} runs ${profile.stack}. Constraints: ${profile.constraints.join("; ")}.${history}`;
        return event("take", id, text, transcript, match && [cite(id, match.memory)]);
      }
      if (!match) {
        const text = `Nothing in ${profile.name}'s history is close to this (our stack: ${profile.stack}). Abstaining.`;
        return event("abstain", id, text, transcript);
      }
      const m = match.memory;
      const parts = [
        `${match.score >= 4 ? "We've done this" : "Closest thing we've done"} at ${profile.name}: "${m.request}" (${m.stack}).`,
        `What we did: ${sentence(m.solution)}`,
        `What broke: ${sentence(m.what_broke)}`,
        smooth(m) ? "" : `Fix: ${sentence(m.fix)}`,
        `Outcome: ${sentence(m.outcome)}`,
      ];
      return event("take", id, parts.filter(Boolean).join(" "), transcript, [cite(id, m)]);
    },

    async challenge(transcript) {
      await pace();
      const { profile, memories } = me();
      const requester = requesterOf(transcript);
      // Other clients' takes; the requester's own take is context, not an approach to challenge.
      const others = transcript.filter((e) => e.type === "take" && e.from !== id && e.from !== requester);
      const evidence = others.map((e) => ({ from: e.from, memory: citedMemory(world, e.cites?.[0]) }));
      const warnings = evidence.filter((x) => x.memory && !smooth(x.memory));

      if (id === requester) {
        const ours = warnings
          .map((w) => ({ ...w, shared: sharedTech(w.memory!.stack, profile.stack) }))
          .find((w) => w.shared.length);
        if (ours) {
          const text = `@${ours.from}, that's our risk too: we also run ${ours.shared.join(", ")}. Whatever we copy has to include your fix.`;
          return event("challenge", id, text, transcript, [cite(ours.from, ours.memory!)]);
        }
        const proven = evidence.filter((x) => x.memory && smooth(x.memory));
        const text = proven.length
          ? `Thanks. Unless someone objects, we'll follow ${mention(proven)}.`
          : "Thanks, all. Nobody has done exactly this, so we'll prototype carefully.";
        return event("challenge", id, text, transcript);
      }

      const match = relevantMemory(memories, transcript.find((e) => e.type === "request")?.text ?? "");
      if (!match) {
        const text = `No relevant history at ${profile.name}, so nothing to challenge. Deferring to ${mention(others) || "the others"}.`;
        return event("challenge", id, text, transcript);
      }
      const m = match.memory;
      if (!smooth(m)) {
        const text = `${mention(others) || `@${requester}`} careful before copying that approach as-is. ${sentence(m.what_broke)} What fixed it for us: ${sentence(m.fix)}`;
        return event("challenge", id, text, transcript, [cite(id, m)]);
      }
      if (warnings.length) {
        const text = `Fair point from ${mention(warnings)}. Our setup (${m.stack}) had nothing like that, so the risk depends on the stack, not the approach. @${requester}, check which of us your stack is closer to.`;
        return event("challenge", id, text, transcript, [cite(id, m)]);
      }
      return event("challenge", id, `No objections. Our experience matches: ${sentence(m.outcome)}`, transcript);
    },

    async writePlan(transcript, fdeConstraints) {
      await pace();
      const { profile } = me();
      const request = transcript.find((e) => e.type === "request")?.text ?? "this request";
      const evidence = new Map<string, { from: AgentName; memory: Memory }>();
      for (const e of transcript) {
        if ((e.type !== "take" && e.type !== "challenge") || e.from === id) continue;
        for (const c of e.cites ?? []) {
          const memory = citedMemory(world, c);
          if (memory && !evidence.has(c)) evidence.set(c, { from: e.from, memory });
        }
      }
      const proven = [...evidence.values()].filter((x) => smooth(x.memory));
      const risks = [...evidence.values()].filter((x) => !smooth(x.memory));

      const lines = [`Plan for ${profile.name}: "${request}"`, "", "Approach:"];
      if (proven.length) lines.push(...proven.map((p) => `- Follow @${p.from}: ${sentence(p.memory.solution)}`));
      else lines.push("- Nobody on the council has done exactly this: start with a small spike behind a feature flag.");
      if (risks.length) {
        lines.push("", "Risks the council raised:");
        for (const r of risks) {
          const shared = sharedTech(r.memory.stack, profile.stack);
          const applies = shared.length ? ` This applies to us: we also run ${shared.join(", ")}.` : "";
          lines.push(`- @${r.from}: ${sentence(firstSentence(r.memory.what_broke))} Fix: ${sentence(r.memory.fix)}${applies}`);
        }
      }
      lines.push("", "Our constraints:", ...profile.constraints.map((c) => `- ${c}`));
      lines.push("", "FDE constraints:", ...(fdeConstraints.length ? fdeConstraints.map((c) => `- ${c}`) : ["- None given"]));
      return { type: "plan", from: id, text: lines.join("\n"), ...(evidence.size ? { cites: [...evidence.keys()] } : {}), ts: Date.now() };
    },
  };
}

// --- helpers -----------------------------------------------------------------------------

function event(type: EventType, from: ClientId, text: string, transcript: Event[], cites?: string[]): Event {
  const fde = transcript.filter((e) => e.type === "fde").at(-1);
  const note = fde ? ` (Taking the FDE's note into account: "${fde.text}")` : "";
  return { type, from, text: text + note, ...(cites?.length ? { cites } : {}), ts: Date.now() };
}

const requesterOf = (transcript: Event[]) => transcript.find((e) => e.type === "request")?.from;
const cite = (id: AgentName, m: Memory) => `${id}: ${m.request}`;
const mention = (xs: { from: AgentName }[]) => xs.map((x) => `@${x.from}`).join(" ");
const smooth = (m: Memory) => /^(nothing|none|no )/i.test(m.what_broke.trim());
const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);
const firstSentence = (s: string) => s.split(/(?<=[.!?])\s/)[0] ?? s;

function citedMemory(world: World, citation: string | undefined): Memory | undefined {
  const match = citation?.match(/^(client-\d): (.*)$/s);
  if (!match) return undefined;
  return world.get(match[1] as ClientId)?.memories.find((m) => m.request === match[2]);
}

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
  const words = (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2 && !STOPWORDS.has(w));
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
