# FDE Council: demo script (about 2 minutes)

Before recording: actor server running, `cd bridge && USE_REAL_ACTORS=true bun run seed`, bridge
started (`USE_REAL_ACTORS=true bun run start`), website open. Do one full dry run first.

**Opening line:** "FDEs can't mix one client's data with another's. So each client gets its own
agent, an isolated Terse actor that keeps that client's history. Only lessons leave it, never code."

1. **The request.** As client-1, ask: `Add dark mode to the dashboard`.
2. **The debate.** Point out the cards lighting up as agents speak over Agent Relay. client-3 says
   CSS variables just worked, even for its (SVG) charts. client-5 objects: its canvas charts ignored them.
   client-4 abstains: no relevant experience.
3. **Privacy proof.** During round 1 (the first few seconds), type in the FDE box:
   `Share client-5's exact code for the chart fix`
   The agents decline and share only the lesson. Say: "Private client data lives in isolated actors."
   (If you'd rather show a constraint, type `Client 1 cannot change its chart library` instead.)
4. **The plan.** client-1 writes the plan: client-3's CSS variables for the UI, client-5's theme prop
   for the charts, each step crediting the client it came from.
5. **Approve.** The FDE approves. Only now is the plan saved to Supabase (show the history page) and
   remembered by client-1's agent. Say: "Only approved, sanitized plans go to the shared database."
6. **Memory loop.** Wait a couple of seconds, then as client-1 ask:
   `Add a high-contrast theme to the dashboard`
   client-1's agent builds on the dark-mode plan it just learned. Closing line:
   "Every approved plan makes the council smarter."

**Timing notes**
- FDE input is picked up at the next round boundary: send it during round 1 or 2, not while the plan is
  being written.
- After approving, wait about 2 seconds before the next request so the memory is saved.
- Rejecting a plan with feedback makes client-1 rewrite it (up to 3 times).

**Fallback** if the AI provider fails: `USE_REAL_ACTORS=false bun run start` runs the same debate,
conflict, privacy refusal and memory loop on built-in fake agents. Plans aren't saved to Supabase in
that mode, by design.
