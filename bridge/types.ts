// SHARED CONTRACT: do not change without telling the team (actors / bridge / web).

export const CLIENT_IDS = ["client-1", "client-2", "client-3", "client-4", "client-5"] as const;
export type ClientId = (typeof CLIENT_IDS)[number];
export type AgentName = ClientId | "fde";

export type EventType = "request" | "take" | "abstain" | "challenge" | "fde" | "plan";
export const EVENT_TYPES: readonly EventType[] = ["request", "take", "abstain", "challenge", "fde", "plan"];

export interface Event {
  type: EventType;
  from: AgentName;
  text: string;
  cites?: string[];
  ts: number; // ms since epoch
}

export interface Memory {
  request: string;
  solution: string;
  what_broke: string;
  fix: string;
  stack: string;
  outcome: string;
}

// Same as actors/src/types.ts. The client id is the actor id, not part of the profile.
export interface ClientProfile {
  name: string;
  stack: string;
  constraints: string[];
}

export function isClientId(value: unknown): value is ClientId {
  return typeof value === "string" && (CLIENT_IDS as readonly string[]).includes(value);
}
