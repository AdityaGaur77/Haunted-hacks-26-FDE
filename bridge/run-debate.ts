// Milestone 2: run one debate in the terminal (messages also go to Relay).
//   bun run debate                                  # client-1: "Add dark mode to the dashboard"
//   bun run debate client-3 "Add SSO for our staff"
// While it runs, type a line and press Enter to jump in as the FDE (or pipe lines in:
//   echo "Must ship behind a flag by Friday" | bun run debate).
import { loadActors } from "./actors";
import { addFdeInput, startDebate } from "./debate";
import { connectRelay } from "./relay";
import { isClientId } from "./types";

const [client = "client-1", ...words] = process.argv.slice(2);
const request = words.join(" ").trim() || "Add dark mode to the dashboard";
if (!isClientId(client)) {
  console.error(`Unknown client "${client}". Use client-1 .. client-5.`);
  process.exit(1);
}

const actors = await loadActors();
const relay = await connectRelay();
const debate = await startDebate({ actors, relay }, client, request);

if (process.stdin.isTTY) console.log("(type a line + Enter to jump in as the FDE)\n");
(async () => {
  for await (const line of console) {
    if (line.trim()) await addFdeInput(actors, debate.seminarId, line.trim());
  }
})().catch((error) => console.error(`stdin: ${error}`));

await debate.done;
process.exit(0);
