# /actors — FDE Council durable actors (Person A)

Runs on the open-source Durable Actors runtime (MIT), locally — no cloud account needed.

## Actors
- `ClientActor` (`client-1`…`client-5`): private memory in its own SQLite. Methods: `seed`, `getProfile`, `remember`, `memoryCount`, `respond`, `challenge`, `writePlan`.
- `SeminarActor` (`seminar-<timestamp>`): live event log. Methods: `start`, `addEvent`, `getEvents`, `getFdeConstraints`, `getState`, `markDone`. Emits `status`, `requestingClient`, `request`, `events`; broadcasts `{ type: "event", event }`. The FDE sends `{ type: "fde", text }` over the socket.

Event shape and memory fields: see `src/types.ts` (shared contract).

## Run
```sh
bun install
cp .env.example .env        # add OPENAI_API_KEY
bunx durable-actors dev      # terminal 1, wait for "Ready" (port 7100)
bunx durable-actors generate # terminal 2, after any method change
bun scripts/smoke.ts         # terminal 2, quick end-to-end test
```

## For the bridge (Person B)
`generated/` is gitignored, so generate your own client: in `/bridge`, run `bun add --dev durable-actors`, then (with the actor server running) `bunx durable-actors generate`. Defaults: project `local`, URL `http://127.0.0.1:7100`, no secret.
Then: `import { actors } from "./generated/index.js"`.
Websocket for the website: `actors.SeminarActor.prepareWebsocket({ actorId, metadata: null })`.
