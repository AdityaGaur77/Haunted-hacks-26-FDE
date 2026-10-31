// HTTP API for the frontend. Start with `bun run start` (PORT, default 4000). CORS is open; no auth.
//
//   POST /debate               { client, request }  -> { seminarId }   starts a debate in the background
//   GET  /seminar/:id/events                         -> Event[]         full log (fallback / replay);
//                                                                       the debate is over once a "plan" event exists
//   GET  /seminar/:id/socket                         -> { websocketUrl, ... } from SeminarActor.prepareWebsocket()
//                                                       (metadata null, as the SeminarActor expects; any query params
//                                                       are sent as metadata instead. Fake actors return a placeholder
//                                                       with fake: true)
//   POST /seminar/:id/fde      { text }              -> Event           the FDE jumps in mid-debate
//   POST /seminar/:id/approve                        -> { state }       approve the plan awaiting approval
//   POST /seminar/:id/reject   { text }              -> { state }       reject it with feedback (plan is rewritten)
//   GET  /clients                                    -> [{ id, name, stack, status }]  from Supabase (falls back
//                                                       to seed-data.json when Supabase isn't configured)
//   GET  /plans                                      -> saved plans, newest first (Supabase; 503 if not configured)
//   GET  /health                                     -> { ok, actors, relay, supabase }
import { loadActors } from "./actors";
import { addFdeInput, startDebate } from "./debate";
import { connectRelay } from "./relay";
import { clientRows, loadSeedData } from "./seed";
import { connectStore } from "./store";
import { isClientId } from "./types";

const actors = await loadActors();
const relay = await connectRelay();
const store = connectStore();

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });
const SEMINAR_PATH = /^\/seminar\/(seminar-\d+)\/(events|socket|fde|approve|reject)$/;

const server = Bun.serve({
  port: Number(process.env.PORT || 4000),
  async fetch(req) {
    const { pathname, searchParams } = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (pathname === "/health" && req.method === "GET") {
      return json({ ok: true, actors: actors.kind, relay: relay.enabled, supabase: store.enabled });
    }

    if (pathname === "/clients" && req.method === "GET") {
      if (!store.enabled) return json(clientRows(await loadSeedData()).map((c) => ({ ...c, status: "active" })));
      return json(await store.listClients());
    }

    if (pathname === "/plans" && req.method === "GET") {
      if (!store.enabled) return json({ error: "Supabase is not configured (SUPABASE_URL, SUPABASE_SERVICE_KEY)" }, 503);
      return json(await store.listPlans());
    }

    if (pathname === "/debate" && req.method === "POST") {
      const body = await readJson(req);
      const request = typeof body?.request === "string" ? body.request.trim() : "";
      if (!isClientId(body?.client)) return json({ error: 'client must be one of "client-1".."client-5"' }, 400);
      if (!request) return json({ error: "request must be a non-empty string" }, 400);
      const { seminarId } = await startDebate({ actors, relay, store }, body.client, request);
      return json({ seminarId });
    }

    const match = pathname.match(SEMINAR_PATH);
    if (!match) return json({ error: "not found" }, 404);
    const [, seminarId, action] = match as unknown as [string, string, string];

    if (action === "events" && req.method === "GET") {
      return json(await actors.seminar(seminarId).getEvents());
    }
    if (action === "socket" && req.method === "GET") {
      const metadata = searchParams.size ? Object.fromEntries(searchParams) : null;
      return json(await actors.prepareSeminarSocket(seminarId, metadata));
    }
    if (action === "fde" && req.method === "POST") {
      const body = await readJson(req);
      const text = typeof body?.text === "string" ? body.text.trim() : "";
      if (!text) return json({ error: "text must be a non-empty string" }, 400);
      return json(await addFdeInput(actors, seminarId, text));
    }
    if ((action === "approve" || action === "reject") && req.method === "POST") {
      const seminar = actors.seminar(seminarId);
      if ((await seminar.getApproval()).state !== "pending") return json({ error: "no plan is awaiting approval" }, 409);
      if (action === "approve") {
        await seminar.approve();
      } else {
        const body = await readJson(req);
        const text = typeof body?.text === "string" ? body.text.trim() : "";
        if (!text) return json({ error: "text (the feedback) must be a non-empty string" }, 400);
        await seminar.reject(text);
      }
      return json(await seminar.getApproval());
    }
    return json({ error: "method not allowed" }, 405);
  },
  error(error) {
    console.error(`[http] ${error.message}`);
    return json({ error: error.message }, 500);
  },
});

console.log(`[http] FDE Council bridge on http://localhost:${server.port} (${actors.kind} actors, Relay ${relay.enabled ? "on" : "off"}, Supabase ${store.enabled ? "on" : "off"})`);

async function readJson(req: Request): Promise<Record<string, any> | undefined> {
  try {
    return (await req.json()) as Record<string, any>;
  } catch {
    return undefined;
  }
}
