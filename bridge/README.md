# FDE Council bridge

Runs the debate. When a client makes a request, the 5 client agents debate it live over
**Agent Relay** (each posts as its own Relay identity), the event log lives in the
**SeminarActor**, and the requesting client writes the plan. The FDE can jump in at any time.

```
POST /debate ──> startDebate(client, request)
   SeminarActor "seminar-<ts>".start()  -> request event   Relay #seminar-<ts>  <── posted as client-N
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
but realistic replies built from `seed-data.json`, in the same style as the real actors (agent ids
only, short texts, numbered plan). Set `FAKE_DELAY_MS=0` for an instant debate.

## HTTP API (for /web)

CORS is open, no auth.

| Endpoint | Body | Returns |
| --- | --- | --- |
| `POST /debate` | `{ "client": "client-1", "request": "Add dark mode" }` | `{ "seminarId": "seminar-1730…" }` (debate runs in the background) |
| `GET /seminar/:id/events` | | `Event[]`, the full log (fallback / replay). The debate is over once a `plan` event is in it |
| `GET /seminar/:id/socket` | | `{ websocketUrl, … }` from `SeminarActor.prepareWebsocket({ actorId, metadata: null })`. Fake actors return a placeholder with `"fake": true`, so poll `/events` instead |
| `POST /seminar/:id/fde` | `{ "text": "Must ship by Friday" }` | the `fde` Event. Agents see it from their next turn; the plan gets it as an FDE constraint |
| `GET /health` | | `{ ok, actors: "fake" \| "real", relay: boolean }` |

```ts
// Event (shared contract, see types.ts / actors/src/types.ts)
{ type: "request" | "take" | "abstain" | "challenge" | "fde" | "plan",
  from: "client-1".."client-5" | "fde", text: string, cites?: string[] /* agent ids */, ts: number }
```

The real socket protocol is in `actors/SOCKET.md`. In short, the SeminarActor sends `state` /
`state_update`, `{ type: "event", event }` for each new event, and `{ type: "typing", from, text }`
while an agent is generating. The bridge passes the seminar id to every agent call, so typing
streams. The FDE can also jump in by sending `{ type: "fde", text }` over the socket, which does the
same as `POST /seminar/:id/fde`.

## Actors (switch to the real ones)

`actors.ts` defines what the bridge calls and holds the switch. `USE_REAL_ACTORS=true` loads the
generated client from `./generated/index.js` or `../actors/generated/index.js` (or `ACTORS_CLIENT`).

| Actor | Methods the bridge calls |
| --- | --- |
| `ClientActor` (`client-1`..`client-5`) | `seed(profile, memories)` (replaces, so it's re-runnable; profile is `{ name, stack, constraints }`), plus `respond`, `challenge` and `writePlan`, each given the seminar id as its last argument |
| `SeminarActor` (`seminar-<ts>`) | `start(client, request)`, `addEvent`, `getEvents`, `markDone`, and `prepareWebsocket` for the socket |

The bridge forgives messy actor output: it forces `from` to the actor's id, fills in a missing
`ts`, and coerces an invalid `type`. Each call gets one retry and a timeout (`ACTOR_TIMEOUT_MS`,
default 90s). An agent that still fails is skipped, and if the plan fails, a clearly-marked
fallback `plan` event ends the debate so the UI never hangs.

**Milestone 4 checklist** (same machine as the actor server):

```bash
cd actors && bunx durable-actors dev               # terminal 1, wait for "Ready" (port 7100)
cd actors && bunx durable-actors generate          # terminal 2: writes actors/generated/
cd bridge && USE_REAL_ACTORS=true bun run seed     # "actor now holds N" stays the same on re-runs
cd bridge && USE_REAL_ACTORS=true bun run debate   # then: USE_REAL_ACTORS=true bun run start
```

## Agent Relay

- Identities: `client-1`..`client-5` (type `agent`) and `fde` (type `human`).
- One channel per debate, named after the seminar id. Every Event is posted as its `from`
  identity with the Event JSON in the message `metadata.event`.
- Config: `RELAY_API_KEY` (workspace key: `ar_ws_…` from `npx -y agent-relay@next init --hosted`, run in a project folder, or an older `rk_live_…`), optional `RELAY_BASE_URL` (`ar_ws_` keys automatically use `https://armadillo.agentrelay.com`),
  `RELAY_WORKSPACE` (name used to auto-create a workspace when no key is set). `USE_RELAY=false`
  turns Relay off. If Relay is unreachable the bridge logs it and debates still run.
- Relay registration is create-only, so tokens are saved in `.relay-state.json` (gitignored)
  and reused. If a name exists without a saved token (e.g. a fresh clone), the bridge deletes and
  re-registers it, so run only one bridge per workspace.

## Seed data

`seed-data.json`: 5 clients, 3–4 memories each (`request, solution, what_broke, fix, stack,
outcome`). Lessons only, no code. `bun run seed` validates it strictly against the contract.

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
