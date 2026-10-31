# FDE Council · frontend

Single-file HTML pages, no build step. Open them directly in Chrome.

| File | What it is |
|---|---|
| `index.html` | Landing page / pitch. Links to the app. |
| `app3.html` | **Main app.** FDE workspace: home with projects and tasks, incoming email, request page with the house council (agents in the windows, knock at the door), horizontal "Your call" next-step card with Approve / Adjust / Skip. |
| `app2.html`, `app.html` | Earlier iterations of the workspace. |
| `workspace.html`, `council.html`, `tool.html` | Earlier concepts (pumpkin network, immersive house, dashboard). |
| `demo.html`, `haunted.html`, `haunted3d.html`, `house.html` | Earlier council visualisations (cards, SVG house, three.js, Kenney 3D house). |

## Demo controls (app3.html)

- `Simulate incoming email` button or `E`: the Northwind request arrives.
- Click the toast or the request row: request page with the council.
- `Adjust` then Enter (or a quick-constraint chip): the council re-plans with your constraint, v2 card appears.
- `Approve` or `A`: reply drafted, task created, visitor leaves.
- `⌘K`: command palette. `Reset`: reload.

## Live mode

The pages run a scripted replay by default. To drive them from the bridge, open with `?ws=ws://host:port`
and send JSON events over the socket. Each page exposes `window.FDE.push(event)` for the same contract:

```json
{ "type": "status",  "agent": "client-5", "state": "thinking|speaking|objecting|idle" }
{ "type": "message", "from": "client-5", "kind": "lesson|objection|revision|none", "cites": "client-5", "text": "..." }
{ "type": "await-fde", "suggestion": "..." }
{ "type": "plan", "for": "client-1", "title": "...", "steps": [ { "text": "...", "source": "client-3" } ] }
```

The page sends back `{type:"start"}`, `{type:"fde", text}` and `{type:"save", plan}`.
`app3.html` uses project ids (`northwind`, `harbor`, `lumen`, `atlas`, `orbit`) and event types
`cstat`, `message`, `suggest`, `act`; see the `SCRIPT` array at the top of its script for the exact shapes.
