// Milestone 2: run one debate in the terminal (messages also go to Relay).
//   bun run debate                                  # client-1: "Add dark mode to the dashboard"
//   bun run debate client-3 "Add SSO for our staff"
// While it runs, type a line and press Enter to jump in as the FDE (or pipe lines in:
//   echo "Must ship behind a flag by Friday" | bun run debate).
// When the plan is awaiting approval: "approve" approves, "reject: <feedback>" rejects
// (the plan is rewritten with the feedback). Anything else is an FDE jump-in.
import { loadActors } from "./actors";
import { addFdeInput, startDebate } from "./debate";
import { connectRelay } from "./relay";
import { connectStore } from "./store";
import { isClientId } from "./types";

const [client = "client-1", ...words] = process.argv.slice(2);
const request = words.join(" ").trim() || "Add dark mode to the dashboard";
if (!isClientId(client)) {
  console.error(`Unknown client "${client}". Use client-1 .. client-5.`);
  process.exit(1);
}

const actors = await loadActors();
const relay = await connectRelay();
const debate = await startDebate({ actors, relay, store: connectStore() }, client, request);

if (process.stdin.isTTY) console.log("(type a line + Enter to jump in as the FDE)\n");
(async () => {
  const seminar = actors.seminar(debate.seminarId);
  for await (const raw of console) {
    const line = raw.trim();
    if (!line) continue;
    const pending = (await seminar.getApproval()).state === "pending";
    const rejection = line.match(/^reject:\s*(.+)$/i);
    if (pending && /^approve$/i.test(line)) await seminar.approve();
    else if (pending && rejection) await seminar.reject(rejection[1]!.trim());
    else await addFdeInput(actors, debate.seminarId, line);
  }
})().catch((error) => console.error(`stdin: ${error}`));

await debate.done;
process.exit(0);
