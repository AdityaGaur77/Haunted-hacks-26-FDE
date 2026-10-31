// The actor interface the bridge codes against, plus the fake/real switch.
//   USE_REAL_ACTORS=true  -> teammate A's actors (/actors) through their generated client
//   otherwise             -> in-memory fakes (fake-actors.ts), no teammate-A code needed
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createFakeActors } from "./fake-actors";
import type { ClientId, ClientProfile, Event, Memory } from "./types";

/** ClientActor, id "client-1".."client-5". Remembers one client's deployment history. */
export interface ClientActor {
  /** Load the profile and memories, REPLACING earlier data (so seeding twice is safe). Returns the memory count. */
  seed(profile: ClientProfile, memories: Memory[]): Promise<number | void>;
  // `seminarId` lets the actor stream live "typing" text to that seminar's socket.
  /** Round 1: returns an Event of type "take" or "abstain". */
  respond(request: string, transcript: Event[], seminarId?: string): Promise<Event>;
  /** Round 2: returns an Event of type "challenge". */
  challenge(transcript: Event[], seminarId?: string): Promise<Event>;
  /** Called on the requesting client: returns an Event of type "plan". */
  writePlan(transcript: Event[], fdeConstraints: string[], seminarId?: string): Promise<Event>;
}

/** SeminarActor, id "seminar-<timestamp>". The debate's event log (source of truth). */
export interface SeminarActor {
  /** Marks the seminar running and records the "request" event, which it returns. */
  start(requestingClient: ClientId, request: string): Promise<Event>;
  addEvent(event: Event): Promise<void>;
  getEvents(): Promise<Event[]>;
  markDone(): Promise<void>;
}

/** What prepareWebsocket() returns: the frontend opens `websocketUrl`. */
export interface SocketGrant {
  websocketUrl: string;
  [key: string]: unknown;
}

export interface Actors {
  readonly kind: "fake" | "real";
  client(id: ClientId): ClientActor;
  seminar(id: string): SeminarActor;
  /** Live socket for the frontend: actors.SeminarActor.prepareWebsocket({ actorId, metadata }). */
  prepareSeminarSocket(seminarId: string, metadata: Record<string, unknown> | null): Promise<SocketGrant>;
}

export async function loadActors(): Promise<Actors> {
  return process.env.USE_REAL_ACTORS === "true" ? loadRealActors() : createFakeActors();
}

async function loadRealActors(): Promise<Actors> {
  // `bunx durable-actors generate` writes ./generated in whichever folder it runs: /actors or /bridge.
  // The generated client connects to the local actor server (127.0.0.1:7100) unless the
  // DURABLE_ACTORS_* environment variables say otherwise.
  const candidates = process.env.ACTORS_CLIENT ? [process.env.ACTORS_CLIENT] : ["./generated/index.js", "../actors/generated/index.js"];
  const paths = candidates.map((p) => path.resolve(import.meta.dir, p));
  const target = paths.find((p) => existsSync(p)) ?? paths[0]!;
  let generated: { actors?: Record<string, any> };
  try {
    generated = await import(pathToFileURL(target).href);
  } catch (error) {
    throw new Error(
      `USE_REAL_ACTORS=true but no generated actor client was found (looked in ${paths.join(", ")}). ` +
        `Start the actor server (\`bunx durable-actors dev\` in /actors), run \`bunx durable-actors generate\` there, ` +
        `or point ACTORS_CLIENT at a generated index.js. Cause: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const actors = generated.actors ?? {};
  for (const name of ["ClientActor", "SeminarActor"]) {
    if (!actors[name]) {
      throw new Error(`The generated actor client has no ${name} (it has: ${Object.keys(actors).join(", ") || "nothing"}).`);
    }
  }
  console.log(`[actors] using REAL actors via ${target}`);

  return {
    kind: "real",
    client: (id) =>
      methods<ClientActor>(actors.ClientActor.get(id), `ClientActor(${id})`, ["seed", "respond", "challenge", "writePlan"]),
    seminar: (id) =>
      methods<SeminarActor>(actors.SeminarActor.get(id), `SeminarActor(${id})`, ["start", "addEvent", "getEvents", "markDone"]),
    prepareSeminarSocket: (seminarId, metadata) =>
      actors.SeminarActor.prepareWebsocket({ actorId: seminarId, metadata }),
  };
}

/** Expose the stub's methods, failing with a clear message if the actor doesn't define one. */
function methods<T>(stub: Record<string, unknown>, label: string, names: string[]): T {
  const bound: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const name of names) {
    bound[name] = async (...args) => {
      const method = stub[name];
      if (typeof method !== "function") throw new Error(`${label} has no method "${name}". Check the actor in /actors.`);
      return method(...args);
    };
  }
  return bound as T;
}
