// Loads seed-data.json into each ClientActor via seed().
//   bun run seed                         # fake actors (in-memory; only checks the data)
//   USE_REAL_ACTORS=true bun run seed    # teammate A's Terse actors
// Safe to run more than once: seed() replaces a client's profile and memories, never appends.
// With SUPABASE_URL + SUPABASE_SERVICE_KEY set, it also upserts the public client list
// (id, name, stack) into Supabase. Memories are never sent there.
import { z } from "zod";
import { loadActors, type Actors } from "./actors";
import { connectStore, type ClientRow } from "./store";
import { CLIENT_IDS } from "./types";

const text = z.string().trim().min(1);
// Memory fields are the shared contract: strict, so a typo or extra field fails loudly.
const MemorySchema = z.strictObject({ request: text, solution: text, what_broke: text, fix: text, stack: text, outcome: text });
const ClientSchema = z.strictObject({
  id: z.enum(CLIENT_IDS),
  name: text,
  stack: text,
  constraints: z.array(text).min(1),
  persona: text.optional(), // tone only (actors/src/prompts.ts); facts come from memories
  memories: z.array(MemorySchema).min(3).max(5),
});
export const SeedSchema = z.strictObject({
  clients: z
    .array(ClientSchema)
    .length(CLIENT_IDS.length)
    .refine((clients) => new Set(clients.map((c) => c.id)).size === CLIENT_IDS.length, "each client id must appear once"),
});
export type SeedData = z.infer<typeof SeedSchema>;

export async function loadSeedData(): Promise<SeedData> {
  return SeedSchema.parse(await Bun.file(new URL("./seed-data.json", import.meta.url)).json());
}

export async function seedAll(actors: Actors, data: SeedData) {
  for (const { id, memories, ...profile } of data.clients) {
    // The actor's id is the client id; the profile itself is { name, stack, constraints }.
    const stored = await actors.client(id).seed(profile, memories);
    const held = typeof stored === "number" ? ` (actor now holds ${stored})` : "";
    console.log(`seeded ${id} (${profile.name}): ${memories.length} memories${held}`);
  }
}

/** The public client list for Supabase: id, name and stack only. No memories, no constraints. */
export const clientRows = (data: SeedData): ClientRow[] => data.clients.map(({ id, name, stack }) => ({ id, name, stack }));

if (import.meta.main) {
  const data = await loadSeedData();
  const actors = await loadActors();
  await seedAll(actors, data);
  console.log(`Done: ${data.clients.length} clients seeded into ${actors.kind} actors.`);
  if (actors.kind === "fake") {
    console.log("(Fake actors live in memory, so this only validated the data. The bridge's fakes load seed-data.json on start.)");
  }
  const store = connectStore();
  if (store.enabled) {
    try {
      await store.upsertClients(clientRows(data)); // upsert by id: safe to re-run
      console.log(`Upserted ${data.clients.length} clients into Supabase (name + stack only).`);
    } catch (error) {
      console.warn(`WARNING: actors are seeded, but Supabase failed: ${error instanceof Error ? error.message : error}`);
    }
  }
}
