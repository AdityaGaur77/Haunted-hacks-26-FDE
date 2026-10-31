// Smoke test for the actors. Run with the dev server up:
//   bun scripts/smoke.ts
// Seeds two clients with a planted conflict, runs a tiny council, prints it.
import { actors } from "../generated/index.js"

const c3 = actors.ClientActor.get("client-3")
const c5 = actors.ClientActor.get("client-5")
const c1 = actors.ClientActor.get("client-1")

await c3.seed({ name: "Client Three", stack: "Next.js, Tailwind, Recharts", constraints: ["strict accessibility"] }, [
    {
        request: "Add dark mode",
        solution: "CSS variables for all colors, toggled by a class on <html>",
        what_broke: "Nothing; shipped in 2 hours",
        fix: "n/a",
        stack: "Next.js, Tailwind",
        outcome: "Shipped, no follow-ups"
    }
])
await c5.seed({ name: "Client Five", stack: "React, Chart.js", constraints: [] }, [
    {
        request: "Add dark mode",
        solution: "CSS variables for all colors",
        what_broke: "Chart.js ignores CSS variables, so charts stayed light and became unreadable",
        fix: "Pass a theme object to the chart library on theme change",
        stack: "React, Chart.js",
        outcome: "Shipped after a follow-up fix"
    }
])
await c1.seed({ name: "Client One", stack: "React, Chart.js", constraints: ["cannot change chart library"] }, [])

const seminarId = `seminar-${Date.now()}`
const seminar = actors.SeminarActor.get(seminarId)
await seminar.start("client-1", "Add dark mode")

// Listen on the live socket to prove agents stream "typing" text.
const typingFrom = new Map<string, number>()
const { websocketUrl } = await actors.SeminarActor.prepareWebsocket({ actorId: seminarId, metadata: null })
const socket = new WebSocket(websocketUrl)
socket.onmessage = event => {
    const msg = JSON.parse(String(event.data))
    if (msg.type === "typing") typingFrom.set(msg.from, (typingFrom.get(msg.from) ?? 0) + 1)
}
await new Promise(resolve => socket.addEventListener("open", resolve, { once: true }))

for (const client of [c3, c5]) {
    const e = await client.respond("Add dark mode", await seminar.getEvents(), seminarId)
    await seminar.addEvent(e)
}
await seminar.addEvent({ type: "fde", from: "fde", text: "Client 1 cannot change its chart library.", ts: Date.now() })
await seminar.addEvent(await c3.challenge(await seminar.getEvents(), seminarId))
await seminar.addEvent(await c1.writePlan(await seminar.getEvents(), await seminar.getFdeConstraints(), seminarId))
await seminar.markDone()

for (const e of await seminar.getEvents()) console.log(`[${e.type}] ${e.from}: ${e.text}${e.cites?.length ? `  (cites ${e.cites.join(", ")})` : ""}`)
socket.close()
const total = [...typingFrom.values()].reduce((x, y) => x + y, 0)
console.log(`\nTyping messages received: ${total} ${JSON.stringify(Object.fromEntries(typingFrom))}`)
console.log(total > 0 ? "PASS: streaming works" : "FAIL: no typing messages (debate still works, only live typing is missing)")
console.log(`Seminar ${seminarId} done.`)
