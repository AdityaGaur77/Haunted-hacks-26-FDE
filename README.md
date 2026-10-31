# FDE Council

**A council of private AI agents, one per client, that turns every client request into a plan built from lessons across all your deployments.**

Built at Haunted Hacks (YC, Oct 31 2026).

## The problem

Forward-deployed engineers juggle many clients. Every deployment teaches a lesson (what broke, what fixed it), but client code and data can never be shared between clients. So lessons stay siloed and the same mistakes repeat at the next client.

## How it works

1. **A client asks for something.** The FDE picks the client and pastes the request.
2. **The council debates it live.** Each client has its own agent, a durable actor holding that client's private memory. The agents share only lessons, never code or data, and challenge each other when their experience disagrees. The FDE can add a constraint mid-debate and every agent adapts.
3. **The FDE approves the plan.** The requesting client's agent writes a plan where every step credits the client it came from. Nothing is saved until the FDE approves. Approved plans are stored and remembered for next time.

## Architecture

```
dashboard (frontend/dashboard.html)
   │  HTTP + WebSocket
bridge (bridge/)  ── runs the debate rounds, posts every message to Agent Relay, saves approved plans to Supabase
   │
actors (actors/)  ── Durable Actors, self-hosted (open-source runtime)
   ├─ ClientActor × 5   private memory in its own SQLite, answers with OpenAI
   └─ SeminarActor      the live debate log, streams typing + events to the dashboard
```

| Part | Tech | Why |
|---|---|---|
| `actors/` | Terse Durable Actors (open-source runtime, run locally) | One isolated actor per client keeps its memory private; client data never leaves our machine |
| `bridge/` | Bun, Agent Relay SDK, Supabase | Agent-to-agent debate over Relay; only approved, sanitized plans go to Supabase |
| `frontend/` | Single-file HTML | `dashboard.html` is the app; `house.html` is an optional 3D view of the same debate |

## Run it

Requires Bun 1.4.2+, an OpenAI key, and (optional) Supabase + Agent Relay keys.

```sh
# 1. Actors
cd actors && bun install && cp .env.example .env   # add OPENAI_API_KEY
bunx durable-actors dev                             # leave running (port 7100)

# 2. Bridge (new terminal)
cd bridge && bun install && cp .env.example .env    # USE_REAL_ACTORS=true, Supabase keys
bunx durable-actors generate && bun run seed
bun run start                                       # port 4000

# 3. Open the app
open frontend/dashboard.html
```

Optional `actors/.env` settings: `MIN_TURN_MS=6500` paces each agent turn so the debate is readable on screen.

## Using the app

- **Overview:** stats and every run the council has handled.
- **Council:** send a request, watch the agents type and debate, add a constraint, then approve or request changes.
- **3D view** (top right): the same live debate as a 3D haunted house. Just for fun.

Client names in the demo are sample data; the client histories are simulated. In production they would come from each deployment's tickets and incidents.
