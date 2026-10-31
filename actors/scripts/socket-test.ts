// End-to-end WebSocket check. Run with `bunx durable-actors dev` already running:
//   bunx durable-actors generate && bun scripts/socket-test.ts
import { actors } from "../generated/index.js"

type SocketMessage = {
    type?: string
    state?: unknown
    changes?: unknown
    event?: { type?: string; from?: string; text?: string }
}

const seminarId = `seminar-socket-${Date.now()}`
const fdeText = "Client 1 cannot change its chart library."
const seminar = actors.SeminarActor.get(seminarId)

const received: SocketMessage[] = []
let connected = false
let initialStateReceived = false
let eventBroadcastReceived = false
let fdeStored = false
let socket: WebSocket | undefined

function label(message: SocketMessage): "state" | "state_update" | "event" | "other" {
    if (message.type === "state") return "state"
    if (message.type === "state_update") return "state_update"
    if (message.type === "event") return "event"
    return "other"
}

function waitFor(predicate: () => boolean, description: string, timeoutMs = 5_000): Promise<void> {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs
        const timer = setInterval(() => {
            if (predicate()) {
                clearInterval(timer)
                resolve()
            } else if (Date.now() >= deadline) {
                clearInterval(timer)
                reject(new Error(`Timed out waiting for ${description}`))
            }
        }, 20)
    })
}

try {
    await seminar.start("client-1", "Add dark mode")
    const { websocketUrl } = await actors.SeminarActor.prepareWebsocket({ actorId: seminarId, metadata: null })
    console.log("Connecting to WebSocket")

    socket = new WebSocket(websocketUrl)
    socket.addEventListener("open", () => {
        connected = true
        console.log("[connected]")
    })
    socket.addEventListener("message", (event) => {
        let message: SocketMessage
        try {
            message = JSON.parse(String(event.data)) as SocketMessage
        } catch {
            message = { type: "other", state: String(event.data) }
        }
        received.push(message)
        const kind = label(message)
        console.log(`[${kind}] ${JSON.stringify(message)}`)

        if (kind === "state") initialStateReceived = true
        if (kind === "event" && message.event?.type === "take" && message.event?.text === "Socket test take") {
            eventBroadcastReceived = true
        }
    })
    socket.addEventListener("error", () => console.error("[socket error]"))

    await waitFor(() => connected, "WebSocket connection")
    await waitFor(() => initialStateReceived, "initial state")

    await seminar.addEvent({ type: "take", from: "client-3", text: "Socket test take", ts: Date.now() })
    await waitFor(() => eventBroadcastReceived, "take event broadcast")

    socket.send(JSON.stringify({ type: "fde", text: fdeText }))
    await waitFor(
        () => received.some(message => message.type === "event" && message.event?.type === "fde" && message.event?.text === fdeText),
        "FDE event broadcast"
    )
    fdeStored = (await seminar.getFdeConstraints()).includes(fdeText)
} catch (error) {
    console.error(error instanceof Error ? error.message : error)
} finally {
    socket?.close()
}

const checks: Array<[string, boolean]> = [
    ["connected", connected],
    ["received initial state", initialStateReceived],
    ["received event broadcast", eventBroadcastReceived],
    ["FDE message stored", fdeStored]
]
for (const [name, passed] of checks) console.log(`${passed ? "PASS" : "FAIL"}: ${name}`)

process.exit(checks.every(([, passed]) => passed) ? 0 : 1)
