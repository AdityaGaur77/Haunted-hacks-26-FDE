# FDE Council bridge

Runs the debate. When a client makes a request, the 5 client agents debate it live over
**Agent Relay** (each posts as its own Relay identity), the event log lives in the
**SeminarActor**, and the requesting client writes the plan. The FDE can jump in at any time.

```
POST /debate ──> startDebate(client, request)
   SeminarActor "seminar-<ts>".start()  -> request event   Relay #seminar-<ts>  <── posted as client-N
   Round 1  all 5 clients in parallel: respond()      -> take | abstain
   Round 2  all 5 clients in parallel: challenge()    -> challenge (each sees all of round 1)
   Plan     requester: writePlan(transcript, fdeConstraints) -> plan, then requestApproval()
   Approval FDE approves -> markDone(), plan saved to Supabase, requester.remember(plan)
            FDE rejects with feedback -> feedback becomes an "fde" event, plan rewritten (max 3 rewrites)
   Each event is published as soon as its call finishes. The SeminarActor is re-read before
   round 2 and before the plan, so FDE input sent during a round reaches the next one
   (and is mirrored to Relay as the "fde" identity).
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
| `bun run debate [client-N] ["request"]` | Full debate printed in the terminal + posted to Relay. Type a line + Enter to jump in as the FDE; when the plan awaits approval, type `approve` or `reject: <feedback>` |
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
| `POST /seminar/:id/approve` | | `{ state: "approved" }`. 409 if no plan is awaiting approval |
| `POST /seminar/:id/reject` | `{ "text": "Keep exports light" }` | `{ state: "rejected", feedback }`. The plan is rewritten with the feedback |
| `GET /clients` | | `[{ id, name, stack, status }]` for the client cards. From Supabase; falls back to `seed-data.json` when Supabase isn't configured |
| `GET /plans` | | Saved plans, newest first: `[{ id, seminar_id, client_id, request, plan, cites, created_at }]` (503 without Supabase) |
| `GET /health` | | `{ ok, actors: "fake" \| "real", relay: boolean, supabase: boolean }` |

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

## Supabase

Only shared, non-private records go here: the client list and the final plans. Client memories
(what broke, fixes, details) never leave the ClientActors.

1. Create a project at supabase.com, open **SQL Editor**, paste `supabase.sql` and **Run** (safe to re-run).
2. From **Project Settings → API**, put the project URL and the `service_role` key in `bridge/.env` as
   `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`. It's a server-only key: never commit it or use it in `/web`.
3. `bun run seed` upserts the 5 clients (`id`, `name`, `stack`; `status` defaults to `active`).
4. After each debate, the bridge inserts the plan into `plans` right after `markDone()`. Only plans from the
   real actors are saved, because fake plans quote seed memories word for word.

RLS is enabled with no policies, so the public key can't read the tables; the website goes through
`GET /clients` and `GET /plans`.

## Seed data

`seed-data.json`: 5 clients, 3–4 memories each (`request, solution, what_broke, fix, stack,
outcome`). Lessons only, no code. `bun run seed` validates it strictly against the contract.

| Client | Who | Role in the dark-mode demo |
| --- | --- | --- |
| client-1 | Lumen Analytics (Next.js, **ECharts**) | The requester. Charts are the product |
| client-2 | Pinecrest Pay (Nuxt, design tokens) | Adjacent: themed with CSS variables; a third-party iframe ignored them |
| client-3 | Harbor Health (Next.js, **SVG charts**, strict WCAG) | **Dark mode with CSS variables in ~2 hours; "our SVG charts picked up the CSS variables, no chart work needed"** |
| client-4 | Atlas Freight (Go API, no UI) | No relevant experience: **abstains** |
| client-5 | Ridgeline Logistics (React, **ECharts**) | **CSS variables broke the charts** (canvas ignores them); **fix: theme prop** |

The planted conflict: client-3 says CSS variables covered its charts too (they're SVG), and client-5
says its canvas charts ignored them. Both are true for their stacks. client-1 uses canvas charts
like client-5, so the right plan is client-3's CSS variables for the UI plus client-5's chart theme prop.
