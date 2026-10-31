# FDE Council bridge

Runs the debate. When a client makes a request, the 5 client agents debate it live over
**Agent Relay** (each posts as its own Relay identity), the event log lives in a Terse
**SeminarActor**, and the requesting client writes the plan. The FDE can jump in at any time.

```
POST /debate ──> startDebate(client, request)
   SeminarActor "seminar-<ts>"  <── request event          Relay #seminar-<ts>  <── posted as client-N
   Round 1  requester first, then the rest: respond()   -> take | abstain
   Round 2  the rest, then the requester: challenge()   -> challenge
   Plan     requester: writePlan(transcript, fdeConstraints) -> plan, then markDone()
   Before every turn the SeminarActor is re-read, so new "fde" events reach the next agent
   (and are mirrored to Relay as the "fde" identity).
```

## Run it

```bash
cd bridge
bun install
cp .env.example .env      # set RELAY_API_KEY (or leave empty to auto-create a workspace)
```

| Command | What it does |
| --- | --- |
| `bun run hello` | Milestone 1: `client-1` and `fde` exchange DMs over Relay (inbox read) |
| `bun run debate [client-N] ["request"]` | Milestone 2: full debate printed in the terminal + posted to Relay. Type a line + Enter to jump in as the FDE |
| `bun run start` | Milestone 3: HTTP API on `PORT` (default 4000) |
| `bun run seed` | Load `seed-data.json` into every ClientActor (safe to re-run) |
| `bun test` / `bun run typecheck` | Tests (fake actors, no network) / type check |

With no teammate code at all, everything runs on the **fake actors** (`fake-actors.ts`): canned
but realistic replies built from `seed-data.json`. Set `FAKE_DELAY_MS=0` for an instant debate.

## HTTP API (for /web)

CORS is open, no auth.

| Endpoint | Body | Returns |
| --- | --- | --- |
| `POST /debate` | `{ "client": "client-1", "request": "Add dark mode" }` | `{ "seminarId": "seminar-1730…" }` (debate runs in the background) |
| `GET /seminar/:id/events` | | `Event[]`, the full log (fallback / replay). The debate is over once a `plan` event is in it |
| `GET /seminar/:id/socket` | | `{ websocketUrl, … }` from `SeminarActor.prepareWebsocket()`. Query params become the socket metadata (default `{ "role": "fde" }`). Fake actors return a placeholder with `"fake": true`, so poll `/events` instead |
| `POST /seminar/:id/fde` | `{ "text": "Must ship by Friday" }` | the `fde` Event. The FDE jumps in; agents see it from their next turn and the plan gets it as an FDE constraint |
| `GET /health` | | `{ ok, actors: "fake" \| "real", relay: boolean }` |

```ts
// Event (shared contract, see types.ts)
{ type: "request" | "take" | "abstain" | "challenge" | "fde" | "plan",
  from: "client-1".."client-5" | "fde", text: string, cites?: string[], ts: number }
```

## Actor interface (for /actors)

`actors.ts` defines what the bridge calls, and the switch: `USE_REAL_ACTORS=true` loads the
generated Terse client from `TERSE_CLIENT` (default `../actors/generated/index.js`, which is where
`terse actor generate` writes when run in `/actors`). The generated client reads `TERSE_ACTOR_URL`
and `TERSE_API_KEY`.

| Actor | Method | Notes |
| --- | --- | --- |
| `ClientActor` (`client-1`..`client-5`) | `seed(profile, memories[])` | Must **replace** earlier data (seed.ts is re-runnable). `profile = { id, name, stack, constraints[] }` |
| | `respond(request, transcript)` | Return an Event of type `take` or `abstain` |
| | `challenge(transcript)` | Return an Event of type `challenge` |
| | `writePlan(transcript, fdeConstraints)` | Return an Event of type `plan` |
| `SeminarActor` (`seminar-<ts>`) | `addEvent(event)` / `getEvents()` / `markDone()` | `getEvents()` must include `fde` events added from the frontend |
| | `prepareWebsocket({ actorId, metadata })` | Called by `GET /seminar/:id/socket`; default metadata `{ role: "fde" }` |

The bridge forgives messy actor output: it forces `from` to the actor's id, fills in a missing
`ts`, and coerces an invalid `type`. Each call gets one retry and a timeout (`ACTOR_TIMEOUT_MS`,
default 90s). An agent that still fails is skipped, and if the plan fails, a clearly-marked
fallback `plan` event ends the debate so the UI never hangs.

**Milestone 4 checklist:** `terse actor generate` in `/actors` → set `USE_REAL_ACTORS=true`
(+ `TERSE_ACTOR_URL` / `TERSE_API_KEY` if not local) → `bun run seed` → `bun run debate`.

## Agent Relay

- Identities: `client-1`..`client-5` (type `agent`) and `fde` (type `human`).
- One channel per debate, named after the seminar id. Every Event is posted as its `from`
  identity with the Event JSON in the message `metadata.event`.
- Config: `RELAY_API_KEY` (workspace key `rk_live_…`), optional `RELAY_BASE_URL`,
  `RELAY_WORKSPACE` (name used to auto-create a workspace when no key is set). `USE_RELAY=false`
  turns Relay off. If Relay is unreachable the bridge logs it and debates still run.
- Relay registration is create-only, so tokens are saved in `.relay-state.json` (gitignored)
  and reused. If a name exists without a saved token (e.g. a fresh clone), the bridge deletes and
  re-registers it, so run only one bridge per workspace.

## Seed data

`seed-data.json`: 5 clients, 3–4 memories each (`request, solution, what_broke, fix, stack,
outcome`). Lessons only, no code.

| Client | Who | Role in the dark-mode demo |
| --- | --- | --- |
| client-1 | Lumen Analytics (Next.js, **ECharts**) | The requester. Charts are the product |
| client-2 | Pinecrest Pay (Nuxt, design tokens) | Adjacent: themed with CSS variables; a third-party iframe ignored them |
| client-3 | Harbor Health (Next.js, no chart library, strict WCAG) | **Dark mode with CSS variables in ~2 hours, no problems** |
| client-4 | Atlas Freight (Go API, no UI) | No relevant experience: **abstains** |
| client-5 | Ridgeline Logistics (React, **ECharts**) | **CSS variables broke the charts** (canvas ignores them); **fix: theme prop** |

The planted conflict is client-3's "it just works" against client-5's "it broke our charts". Since
client-1 uses the same chart library as client-5, the right plan is CSS variables for the app
shell plus the chart theme prop.
