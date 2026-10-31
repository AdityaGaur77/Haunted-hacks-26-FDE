// Milestone 1: two Relay identities exchange one message.
// client-1 DMs fde, fde reads it from its inbox and replies, client-1 reads the reply.
//   bun run hello
import type { RelayAgentClient } from "@agent-relay/sdk";
import { connectRelay } from "./relay";

const relay = await connectRelay();
if (!relay.enabled) {
  console.error("Relay is not connected. Set RELAY_API_KEY (see .env.example) and try again.");
  process.exit(1);
}

const client1 = relay.agent("client-1");
const fde = relay.agent("fde");

await exchange(client1, fde, `Hi fde, client-1 here (${new Date().toISOString()})`);
await exchange(fde, client1, "Hi client-1, fde here. Message received.");
console.log("\nMilestone 1 OK: client-1 and fde exchanged messages over Relay.");

async function exchange(from: RelayAgentClient, to: RelayAgentClient, text: string) {
  await from.sendMessage({ to: `@${to.name}`, text });
  console.log(`${from.name} -> ${to.name}: ${text}`);

  const inbox = await to.inbox.get();
  const unread = inbox.unreadDms.find((dm) => dm.from === from.name);
  const received = unread?.lastMessage;
  if (!received || received.text !== text) {
    throw new Error(`${to.name} did not find the message in its inbox: ${JSON.stringify(inbox.unreadDms)}`);
  }
  await to.messages.markRead(received.id);
  console.log(`${to.name} read from its inbox: "${received.text}"`);
}
