# Live debate WebSocket

The website connects with a short-lived `websocketUrl` issued by the backend.
The browser must **not** call the actor server API to mint this URL: the backend
authenticates the user, authorizes access to the seminar, then gives the URL to
the browser. Treat the URL as a credential.

```ts
// Backend route/action (after its auth and seminar-access checks)
const grant = await actors.SeminarActor.prepareWebsocket({
  actorId: seminarId,
  metadata: null,
})
return { websocketUrl: grant.websocketUrl }
```

## Messages from the server

On connection, `@Emittable` actor fields produce an initial `state` message.
Later field changes produce `state_update`; new transcript entries are also
broadcast as `event` messages. These examples are from `scripts/socket-test.ts`:

```json
{"state":{"events":[{"from":"client-1","text":"Add dark mode","ts":1793476010965,"type":"request"}],"request":"Add dark mode","requestingClient":"client-1","status":"running"},"type":"state","version":4}
{"type":"event","event":{"from":"client-3","text":"Socket test take","ts":1793476011034,"type":"take"}}
{"changes":{"events":[{"from":"client-1","text":"Add dark mode","ts":1793476010965,"type":"request"},{"from":"client-3","text":"Socket test take","ts":1793476011034,"type":"take"}]},"removed":[],"type":"state_update","version":5}
```

The `ts` values above are Unix-millisecond timestamps captured in a test run;
future messages naturally use different values. A state update can include any changed persisted/emittable field (`status`,
`requestingClient`, `request`, or `events`). Prefer `event` to append a single
new transcript item, and use `state`/`state_update` to initialize or reconcile
local state.

## Message to the server

An FDE can jump in with:

```json
{"type":"fde","text":"Client 1 cannot change its chart library."}
```

The actor stores it and broadcasts it back as an `event` whose `from` is `"fde"`.

Each `CouncilEvent` has `type`, `from`, `text`, optional `cites`, and `ts`:

```ts
type CouncilEvent = {
  type: "request" | "take" | "abstain" | "challenge" | "fde" | "plan"
  from: "client-1" | "client-2" | "client-3" | "client-4" | "client-5" | "fde"
  text: string
  cites?: string[]
  ts: number
}
```

## Minimal React connection

```tsx
useEffect(() => {
  const socket = new WebSocket(websocketUrl) // returned by your backend
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (message.type === "state") setEvents(message.state.events)
    if (message.type === "state_update" && message.changes.events) {
      setEvents(message.changes.events)
    }
    if (message.type === "event") {
      setEvents(previous => [...previous, message.event])
    }
  }
  return () => socket.close()
}, [websocketUrl])
```

To submit the FDE form: `socket.send(JSON.stringify({ type: "fde", text }))`.
