// Agent Relay connection: one identity per council member ("client-1".."client-5" + "fde").
//
// Env:
//   RELAY_API_KEY    workspace key (rk_live_...). RELAY_WORKSPACE_KEY is accepted too.
//   RELAY_BASE_URL   optional, defaults to the hosted Relay (https://cast.agentrelay.com)
//   RELAY_WORKSPACE  workspace name used when no key is set (a new workspace is created once
//                    and its key saved to .relay-state.json). A value starting with "rk_" is used as the key.
//   USE_RELAY=false  run without Relay (debates still work; nothing is posted)
//
// Relay registration is create-only, so each identity's token is saved in .relay-state.json
// (gitignored) and reused on the next run via reconnect().
import { AgentRelay, isInvalidAgentTokenError, type RelayAgentClient } from "@agent-relay/sdk";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { CLIENT_IDS, type AgentName } from "./types";

const STATE_FILE = new URL("./.relay-state.json", import.meta.url).pathname;
const IDENTITIES: AgentName[] = [...CLIENT_IDS, "fde"];

interface RelayState {
  baseUrl: string;
  workspaceKey?: string;
  tokens: Partial<Record<AgentName, string>>;
}

export interface Relay {
  readonly enabled: boolean;
  /** Create #channel (as fde) and have every identity join it. Never throws. */
  openChannel(channel: string, topic: string): Promise<void>;
  /** Post to #channel as one of the 6 identities. Never throws. */
  post(as: AgentName, channel: string, text: string, metadata?: Record<string, unknown>): Promise<void>;
  /** Raw SDK client for an identity (used by hello.ts). */
  agent(name: AgentName): RelayAgentClient;
}

const disabledRelay: Relay = {
  enabled: false,
  async openChannel() {},
  async post() {},
  agent() {
    throw new Error("Relay is disabled");
  },
};

export async function connectRelay(): Promise<Relay> {
  if (process.env.USE_RELAY === "false") {
    console.log("[relay] disabled (USE_RELAY=false)");
    return disabledRelay;
  }
  try {
    return await connect();
  } catch (error) {
    console.error(`[relay] could not connect, continuing WITHOUT Relay: ${message(error)}`);
    return disabledRelay;
  }
}

async function connect(): Promise<Relay> {
  const baseUrl = process.env.RELAY_BASE_URL || undefined;
  const workspaceSetting = process.env.RELAY_WORKSPACE?.trim();
  const envKey =
    process.env.RELAY_API_KEY?.trim() ||
    process.env.RELAY_WORKSPACE_KEY?.trim() ||
    (workspaceSetting?.startsWith("rk_") ? workspaceSetting : undefined);

  let state = loadState();
  const stateBaseUrl = baseUrl ?? "default";
  const keyChanged = envKey !== undefined && envKey !== state.workspaceKey;
  if (state.baseUrl !== stateBaseUrl || keyChanged) {
    // Tokens belong to one workspace on one server; never reuse them elsewhere.
    state = { baseUrl: stateBaseUrl, workspaceKey: envKey, tokens: {} };
  }

  let relay: AgentRelay;
  if (state.workspaceKey) {
    relay = new AgentRelay({ workspaceKey: state.workspaceKey, ...(baseUrl ? { baseUrl } : {}) });
  } else {
    const name = workspaceSetting || "fde-council";
    relay = await AgentRelay.createWorkspace({ name, ...(baseUrl ? { baseUrl } : {}) });
    state.workspaceKey = relay.workspaceKey;
    console.log(
      `[relay] created workspace "${name}". Its key is saved in bridge/.relay-state.json; ` +
        `put it in RELAY_API_KEY to share the workspace with your team.`,
    );
  }

  const clients = await Promise.all(IDENTITIES.map((name) => ensureAgent(relay, state, name)));
  saveState(state);
  const agents = Object.fromEntries(IDENTITIES.map((name, i) => [name, clients[i]])) as Record<AgentName, RelayAgentClient>;
  console.log(`[relay] connected as ${IDENTITIES.join(", ")}`);

  return {
    enabled: true,
    async openChannel(channel, topic) {
      try {
        try {
          await agents.fde.channels.create({ name: channel, topic });
        } catch (error) {
          if (errorCode(error) !== "name_conflict") throw error; // already exists: just join
        }
        await Promise.all(IDENTITIES.map((name) => agents[name].channels.join(channel)));
      } catch (error) {
        console.warn(`[relay] could not open #${channel}: ${message(error)}`);
      }
    },
    async post(as, channel, text, metadata) {
      try {
        await agents[as].sendMessage({ to: `#${channel}`, text, ...(metadata ? { metadata } : {}) });
      } catch (error) {
        console.warn(`[relay] post to #${channel} as ${as} failed: ${message(error)}`);
      }
    },
    agent: (name) => agents[name],
  };
}

async function ensureAgent(relay: AgentRelay, state: RelayState, name: AgentName): Promise<RelayAgentClient> {
  const type = name === "fde" ? "human" : "agent";
  const saved = state.tokens[name];
  if (saved) {
    try {
      return await relay.workspace.reconnect({ apiToken: saved });
    } catch (error) {
      if (!isInvalidAgentTokenError(error) && errorStatus(error) !== 401) throw error;
      // Stale token (agent was deleted or taken over): register again below.
    }
  }
  let agent: RelayAgentClient;
  try {
    agent = await relay.workspace.register({ name, type });
  } catch (error) {
    if (errorCode(error) !== "name_conflict") throw error;
    // The name exists but this machine has no token for it (e.g. registered from another laptop).
    console.warn(`[relay] "${name}" already exists without a saved token here; taking it over.`);
    await relay.agents.delete(name);
    agent = await relay.workspace.register({ name, type });
  }
  if (!agent.token) throw new Error(`Relay returned no token for "${name}"`);
  state.tokens[name] = agent.token;
  return agent;
}

function loadState(): RelayState {
  if (!existsSync(STATE_FILE)) return { baseUrl: "", tokens: {} };
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return { baseUrl: String(parsed.baseUrl ?? ""), workspaceKey: parsed.workspaceKey, tokens: parsed.tokens ?? {} };
  } catch {
    return { baseUrl: "", tokens: {} };
  }
}

function saveState(state: RelayState) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

const errorCode = (error: unknown) => (error as { code?: string } | null)?.code;
const errorStatus = (error: unknown) => (error as { status?: number } | null)?.status;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
