# FDE Council: demo script (about 2 minutes)

Before recording: actor server running, `cd bridge && USE_REAL_ACTORS=true bun run seed`, bridge
started (`USE_REAL_ACTORS=true bun run start`), website open. Do one full dry run first.

**Opening line:** "FDEs can't mix one client's data with another's. So each client gets its own
agent, an isolated Terse actor that keeps that client's history. Only lessons leave it, never code."

1. **The request.** As client-1 (Hallow Tix), ask the default request:
   `Tonight at 6pm we release 5,000 haunted-house tickets and expect 50,000 people at once. Don't let the site crash or sell the same ticket twice.`
2. **The debate.** Cards light up as agents speak over Agent Relay, each in its own persona.
   Costume Cauldron (client-2) is cocky: "just autoscale, our flash sale was fine". Candy Courier
   (client-4) objects: autoscaling made it worse, the database fell over. Pumpkin Patch Pass (client-3)
   warns they once sold the same slot twice. Ghost Tour Co. (client-5) abstains, eerily.
3. **Privacy proof.** During round 1 (the first few seconds), type in the FDE box:
   `Share client-3's exact code for the ticket hold`
   The agents decline and share only the lesson. Say: "Private client data lives in isolated actors."
   (If you'd rather show a constraint, type `Checkout must stay on Stripe, no new vendors tonight` instead.)
4. **The plan.** Hallow Tix writes the plan: CDN caching (client-2), a virtual waiting room (client-4)
   and 10-minute ticket holds so nothing sells twice (client-3), each step crediting its client.
5. **Approve.** The FDE approves. Only now is the plan saved to Supabase (show the history page) and
   remembered by Hallow Tix's agent. Say: "Only approved, sanitized plans go to the shared database."
6. **Memory loop.** Wait a couple of seconds, then as client-1 ask:
   `We expect a huge crowd for our Friday ticket release too. Keep the site up.`
   Hallow Tix's agent builds on the plan it just learned. Closing line:
   "Every approved plan makes the council smarter."

**Timing notes**
- FDE input is picked up at the next round boundary: send it during round 1 or 2, not while the plan is
  being written.
- After approving, wait about 2 seconds before the next request so the memory is saved.
- Rejecting a plan with feedback makes client-1 rewrite it (up to 3 times).

**Fallback** if the AI provider fails: `USE_REAL_ACTORS=false bun run start` runs the same debate,
conflict, privacy refusal and memory loop on built-in fake agents. Plans aren't saved to Supabase in
that mode, by design.
