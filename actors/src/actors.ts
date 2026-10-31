import { openai } from "@ai-sdk/openai"
import { streamText } from "ai"
import { Actor, type ActorSocket, Emittable, Interleave, Persisted } from "durable-actors"

import { describeSelf, planPrompt, challengePrompt, respondPrompt } from "./prompts.js"
import type { Approval, ClientId, ClientProfile, CouncilEvent, EventType, Memory, SeminarStatus } from "./types.js"

export type { Approval, ApprovalState, ClientId, ClientProfile, CouncilEvent, EventType, Memory, SeminarStatus } from "./types.js"

const MODEL = process.env.OPENAI_MODEL ?? "gpt-5-mini"
// Reasoning models think before answering; "minimal" keeps the live debate fast.
const REASONING_EFFORT = process.env.OPENAI_REASONING_EFFORT ?? "minimal"
const IS_REASONING_MODEL = /^(gpt-5|o\d)/.test(MODEL)
// Minimum time per agent turn (ms). The reply "types out" word by word over this time,
// so the live debate is readable on video. 0 = as fast as possible.
const MIN_TURN_MS = Number(process.env.MIN_TURN_MS ?? 0)

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Type the final text out word by word over the remaining turn time. */
async function paceTyping(from: string, seminarId: string, text: string, startedAt: number): Promise<void> {
    const remaining = MIN_TURN_MS - (Date.now() - startedAt)
    if (remaining <= 0 || !text) return
    const words = text.split(" ")
    // ~2 updates per second: enough to look like typing without flooding the seminar's mailbox.
    const steps = Math.min(words.length, Math.max(1, Math.floor(remaining / 500)))
    const perStep = remaining / steps
    for (let i = 1; i <= steps; i++) {
        const shown = words.slice(0, Math.ceil((words.length * i) / steps)).join(" ")
        SeminarActor.get(seminarId).typing(from, shown).catch(() => {})
        await sleep(perStep)
    }
}

type LlmReply = { abstain: boolean; text: string; cites: string[] }

// Pull the (possibly incomplete) "text" field out of a streaming JSON reply.
function partialText(raw: string): string {
    const m = raw.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)/)
    if (!m) return ""
    return m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\")
}

/**
 * Calls the model and streams partial text to the seminar (if given) so the
 * website shows the agent "typing". Streaming failures never break the reply.
 */
async function askLlm(system: string, prompt: string, from?: string, seminarId?: string): Promise<LlmReply> {
    const startedAt = Date.now()
    const pacing = MIN_TURN_MS > 0 && Boolean(seminarId && from)
    const result = streamText({
        model: openai(MODEL),
        system,
        prompt,
        ...(IS_REASONING_MODEL ? { providerOptions: { openai: { reasoningEffort: REASONING_EFFORT } } } : {})
    })
    let text = ""
    let lastSent = 0
    let lastShown = ""
    for await (const chunk of result.textStream) {
        text += chunk
        if (!seminarId || !from || pacing) continue
        const now = Date.now()
        const shown = partialText(text)
        if (shown && shown !== lastShown && now - lastSent > 250) {
            lastSent = now
            lastShown = shown
            SeminarActor.get(seminarId).typing(from, shown).catch(() => {})
        }
    }
    let reply: LlmReply
    try {
        const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1))
        reply = {
            abstain: Boolean(json.abstain),
            text: String(json.text ?? "").trim(),
            cites: Array.isArray(json.cites) ? json.cites.map(String) : []
        }
    } catch {
        reply = { abstain: false, text: text.trim(), cites: [] }
    }
    if (pacing) await paceTyping(from!, seminarId!, reply.text, startedAt)
    return reply
}

function makeEvent(id: string, type: EventType, r: LlmReply): CouncilEvent {
    return { type, from: id as ClientId, text: r.text, cites: r.cites, ts: Date.now() }
}

// ---------------------------------------------------------------------------
// ClientActor: one per client deployment ("client-1" ... "client-5").
// Holds that client's private memory in its own SQLite. Only lessons leave it.
// ---------------------------------------------------------------------------
export class ClientActor extends Actor {
    @Persisted private profile: ClientProfile | null = null

    private async ensureTable(): Promise<void> {
        this.db.exec(`CREATE TABLE IF NOT EXISTS memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            request TEXT NOT NULL,
            solution TEXT NOT NULL,
            what_broke TEXT NOT NULL,
            fix TEXT NOT NULL,
            stack TEXT NOT NULL,
            outcome TEXT NOT NULL
        )`)
    }

    private async memories(): Promise<Memory[]> {
        await this.ensureTable()
        return this.db.exec(
            "SELECT request, solution, what_broke, fix, stack, outcome FROM memories ORDER BY id"
        ) as unknown as Memory[]
    }

    private async self(): Promise<string> {
        return describeSelf(this.id, this.profile, await this.memories())
    }

    /** Load seed data. Safe to run more than once: replaces existing memories. */
    async seed(profile: ClientProfile, memories: Memory[]): Promise<number> {
        await this.ensureTable()
        this.profile = profile
        this.db.exec("DELETE FROM memories")
        for (const m of memories) {
            this.db.exec(
                "INSERT INTO memories (request, solution, what_broke, fix, stack, outcome) VALUES (?, ?, ?, ?, ?, ?)",
                m.request, m.solution, m.what_broke, m.fix, m.stack, m.outcome
            )
        }
        return memories.length
    }

    async getProfile(): Promise<ClientProfile | null> {
        return this.profile
    }

    /** Add a lesson after a plan is approved, so the next council is smarter. */
    async remember(memory: Memory): Promise<void> {
        await this.ensureTable()
        this.db.exec(
            "INSERT INTO memories (request, solution, what_broke, fix, stack, outcome) VALUES (?, ?, ?, ?, ?, ?)",
            memory.request, memory.solution, memory.what_broke, memory.fix, memory.stack, memory.outcome
        )
    }

    async memoryCount(): Promise<number> {
        return (await this.memories()).length
    }

    /** Round 1: share one sanitized lesson, or abstain. */
    @Interleave
    async respond(request: string, transcript: CouncilEvent[], seminarId?: string): Promise<CouncilEvent> {
        const { system, prompt } = respondPrompt(await this.self(), request, transcript)
        const r = await askLlm(system, prompt, this.id, seminarId)
        return makeEvent(this.id, r.abstain ? "abstain" : "take", r)
    }

    /** Round 2: push back if this deployment's memory contradicts someone. */
    @Interleave
    async challenge(transcript: CouncilEvent[], seminarId?: string): Promise<CouncilEvent> {
        const { system, prompt } = challengePrompt(await this.self(), transcript)
        return makeEvent(this.id, "challenge", await askLlm(system, prompt, this.id, seminarId))
    }

    /** Final: the requesting client writes the plan, citing sources. */
    @Interleave
    async writePlan(transcript: CouncilEvent[], fdeConstraints: string[], seminarId?: string): Promise<CouncilEvent> {
        const { system, prompt } = planPrompt(await this.self(), transcript, fdeConstraints)
        return makeEvent(this.id, "plan", await askLlm(system, prompt, this.id, seminarId))
    }
}

// ---------------------------------------------------------------------------
// SeminarActor: one per debate ("seminar-<timestamp>").
// Append-only event log, pushed live to the website over WebSocket.
// The FDE jumps in by sending { type: "fde", text } over the socket.
// ---------------------------------------------------------------------------
type SeminarIncoming =
    | { type: "fde"; text: string }
    | { type: "approve" }
    | { type: "reject"; text: string }
type SeminarOutgoing =
    | { type: "event"; event: CouncilEvent }
    | { type: "typing"; from: string; text: string }
type SeminarSocket = ActorSocket<null, SeminarOutgoing>

export class SeminarActor extends Actor<null, SeminarIncoming, SeminarOutgoing> {
    @Persisted @Emittable status: SeminarStatus = "idle"
    @Persisted @Emittable requestingClient: string | null = null
    @Persisted @Emittable request: string | null = null
    @Persisted @Emittable events: CouncilEvent[] = []
    @Persisted @Emittable approval: Approval = { state: "none" }

    async start(requestingClient: ClientId, request: string): Promise<CouncilEvent> {
        this.status = "running"
        this.requestingClient = requestingClient
        this.request = request
        this.events = []
        this.approval = { state: "none" }
        const e: CouncilEvent = { type: "request", from: requestingClient, text: request, ts: Date.now() }
        await this.append(e)
        return e
    }

    async addEvent(event: CouncilEvent): Promise<void> {
        await this.append({ ...event, ts: event.ts ?? Date.now() })
    }

    async getEvents(): Promise<CouncilEvent[]> {
        return this.events
    }

    async getFdeConstraints(): Promise<string[]> {
        return this.events.filter(e => e.type === "fde").map(e => e.text)
    }

    async getState(): Promise<{ status: SeminarStatus; requestingClient: string | null; request: string | null; events: CouncilEvent[]; approval: Approval }> {
        return { status: this.status, requestingClient: this.requestingClient, request: this.request, events: this.events, approval: this.approval }
    }

    /** Live partial text while an agent is generating. Not saved; the final reply arrives as an event. */
    async typing(from: string, text: string): Promise<void> {
        this.broadcast({ type: "typing", from, text })
    }

    async markDone(): Promise<void> {
        this.status = "done"
    }

    /** The draft plan is in: wait for the FDE to approve or reject it. */
    async requestApproval(): Promise<void> {
        this.status = "awaiting_approval"
        this.approval = { state: "pending" }
    }

    async getApproval(): Promise<Approval> {
        return this.approval
    }

    /** FDE signs off on the latest plan. */
    async approve(): Promise<void> {
        if (this.approval.state !== "pending") return
        this.approval = { state: "approved" }
        await this.append({ type: "fde", from: "fde", text: "Approved the plan.", ts: Date.now() })
    }

    /** FDE rejects the plan; the feedback becomes a constraint for the rewrite. */
    async reject(feedback: string): Promise<void> {
        if (this.approval.state !== "pending") return
        const text = String(feedback ?? "").trim() || "Rejected the plan. Revise it."
        this.approval = { state: "rejected", feedback: text }
        this.status = "running"
        await this.append({ type: "fde", from: "fde", text, ts: Date.now() })
    }

    async onMessage(_socket: SeminarSocket, message: SeminarIncoming): Promise<void> {
        if (message?.type === "approve") return this.approve()
        if (message?.type === "reject") return this.reject(message.text)
        if (message?.type !== "fde" || !String(message.text ?? "").trim()) return
        await this.append({ type: "fde", from: "fde", text: String(message.text).trim(), ts: Date.now() })
    }

    private async append(e: CouncilEvent): Promise<void> {
        this.events = [...this.events, e]
        this.broadcast({ type: "event", event: e })
    }
}
