import { openai } from "@ai-sdk/openai"
import { generateText } from "ai"
import { Actor, type ActorSocket, Emittable, Interleave, Persisted } from "durable-actors"

import { describeSelf, planPrompt, challengePrompt, respondPrompt } from "./prompts.js"
import type { ClientId, ClientProfile, CouncilEvent, EventType, Memory, SeminarStatus } from "./types.js"

export type { ClientId, ClientProfile, CouncilEvent, EventType, Memory, SeminarStatus } from "./types.js"

const MODEL = process.env.OPENAI_MODEL ?? "gpt-5-mini"

type LlmReply = { abstain: boolean; text: string; cites: string[] }

async function askLlm(system: string, prompt: string): Promise<LlmReply> {
    const { text } = await generateText({ model: openai(MODEL), system, prompt })
    try {
        const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1))
        return {
            abstain: Boolean(json.abstain),
            text: String(json.text ?? "").trim(),
            cites: Array.isArray(json.cites) ? json.cites.map(String) : []
        }
    } catch {
        return { abstain: false, text: text.trim(), cites: [] }
    }
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
    async respond(request: string, transcript: CouncilEvent[]): Promise<CouncilEvent> {
        const { system, prompt } = respondPrompt(await this.self(), request, transcript)
        const r = await askLlm(system, prompt)
        return makeEvent(this.id, r.abstain ? "abstain" : "take", r)
    }

    /** Round 2: push back if this deployment's memory contradicts someone. */
    @Interleave
    async challenge(transcript: CouncilEvent[]): Promise<CouncilEvent> {
        const { system, prompt } = challengePrompt(await this.self(), transcript)
        return makeEvent(this.id, "challenge", await askLlm(system, prompt))
    }

    /** Final: the requesting client writes the plan, citing sources. */
    @Interleave
    async writePlan(transcript: CouncilEvent[], fdeConstraints: string[]): Promise<CouncilEvent> {
        const { system, prompt } = planPrompt(await this.self(), transcript, fdeConstraints)
        return makeEvent(this.id, "plan", await askLlm(system, prompt))
    }
}

// ---------------------------------------------------------------------------
// SeminarActor: one per debate ("seminar-<timestamp>").
// Append-only event log, pushed live to the website over WebSocket.
// The FDE jumps in by sending { type: "fde", text } over the socket.
// ---------------------------------------------------------------------------
type SeminarIncoming = { type: "fde"; text: string }
type SeminarOutgoing = { type: "event"; event: CouncilEvent }
type SeminarSocket = ActorSocket<null, SeminarOutgoing>

export class SeminarActor extends Actor<null, SeminarIncoming, SeminarOutgoing> {
    @Persisted @Emittable status: SeminarStatus = "idle"
    @Persisted @Emittable requestingClient: string | null = null
    @Persisted @Emittable request: string | null = null
    @Persisted @Emittable events: CouncilEvent[] = []

    async start(requestingClient: ClientId, request: string): Promise<CouncilEvent> {
        this.status = "running"
        this.requestingClient = requestingClient
        this.request = request
        this.events = []
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

    async getState(): Promise<{ status: SeminarStatus; requestingClient: string | null; request: string | null; events: CouncilEvent[] }> {
        return { status: this.status, requestingClient: this.requestingClient, request: this.request, events: this.events }
    }

    async markDone(): Promise<void> {
        this.status = "done"
    }

    async onMessage(_socket: SeminarSocket, message: SeminarIncoming): Promise<void> {
        if (message?.type !== "fde" || !String(message.text ?? "").trim()) return
        await this.append({ type: "fde", from: "fde", text: String(message.text).trim(), ts: Date.now() })
    }

    private async append(e: CouncilEvent): Promise<void> {
        this.events = [...this.events, e]
        this.broadcast({ type: "event", event: e })
    }
}
