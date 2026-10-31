// Supabase: shared, NON-PRIVATE records only.
//   clients: id, name, stack, status      (from seed-data.json; never memories)
//   plans:   seminar_id, client_id, request, plan, cites, created_at
// CONFIDENTIALITY: client memories (what broke, fixes, details) never leave the ClientActors.
// Nothing here accepts a Memory, so they can't be written by accident.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (server-only key; keep it in .env, never in /web).
// Without them the store is disabled: debates still run, plans just aren't saved.
import { createClient } from "@supabase/supabase-js";
import type { ClientId } from "./types";

export interface ClientRow {
  id: ClientId;
  name: string;
  stack: string;
  status?: string;
}

export interface PlanRow {
  seminar_id: string;
  client_id: ClientId;
  request: string;
  plan: string;
  cites: string[];
}

export interface Store {
  readonly enabled: boolean;
  upsertClients(rows: ClientRow[]): Promise<void>;
  savePlan(row: PlanRow): Promise<void>;
  listClients(): Promise<ClientRow[]>;
  listPlans(): Promise<(PlanRow & { id: string; created_at: string })[]>;
}

export const disabledStore: Store = {
  enabled: false,
  async upsertClients() {},
  async savePlan() {},
  async listClients() {
    throw new Error("Supabase is not configured (set SUPABASE_URL and SUPABASE_SERVICE_KEY)");
  },
  async listPlans() {
    throw new Error("Supabase is not configured (set SUPABASE_URL and SUPABASE_SERVICE_KEY)");
  },
};

export function connectStore(): Store {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_KEY?.trim();
  if (!url || !key) {
    console.log("[supabase] not configured (SUPABASE_URL / SUPABASE_SERVICE_KEY): plans won't be saved");
    return disabledStore;
  }
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const check = <T>({ data, error }: { data: T; error: { message: string } | null }, what: string): T => {
    if (error) throw new Error(`[supabase] ${what}: ${error.message}`);
    return data;
  };
  return {
    enabled: true,
    async upsertClients(rows) {
      // Explicit columns only, so nothing else can slip through.
      const clean = rows.map(({ id, name, stack }) => ({ id, name, stack }));
      check(await db.from("clients").upsert(clean, { onConflict: "id" }), "upsert clients");
    },
    async savePlan({ seminar_id, client_id, request, plan, cites }) {
      check(await db.from("plans").insert({ seminar_id, client_id, request, plan, cites }), "insert plan");
    },
    async listClients() {
      return check(await db.from("clients").select("id, name, stack, status").order("id"), "list clients") ?? [];
    },
    async listPlans() {
      const result = await db
        .from("plans")
        .select("id, seminar_id, client_id, request, plan, cites, created_at")
        .order("created_at", { ascending: false });
      return check(result, "list plans") ?? [];
    },
  };
}
