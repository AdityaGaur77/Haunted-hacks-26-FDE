import type { ClientProfile, CouncilEvent, Memory } from "./types.js"

// Every client agent follows this rule. It is the core of the product:
// client data stays inside its own actor; only sanitized lessons leave it.
export const CONFIDENTIALITY_RULE = `CONFIDENTIALITY (never break this):
- Share only generalized engineering lessons, e.g. "CSS variables were ignored by our chart library".
- Never include code, file names, file paths, URLs, credentials, data, or any client or company names.
- Refer to deployments only by agent id (client-1 ... client-5), never by real name.`

const OUTPUT_FORMAT = `Reply with ONLY a JSON object, no markdown:
{"abstain": boolean, "text": string, "cites": string[]}
- "text": 1-3 short sentences, spoken in first person as this deployment's agent.
- "cites": agent ids whose experience you relied on (include your own id when you use your own memory).`

export function describeSelf(id: string, profile: ClientProfile | null, memories: Memory[]): string {
    const p = profile
        ? `Stack: ${profile.stack}\nConstraints: ${profile.constraints.join("; ") || "none"}` +
          (profile.persona
              ? `\nPersonality: ${profile.persona}. Let this flavor your tone (a short phrase or attitude), but keep every fact from your memory and keep it clear and useful.`
              : "")
        : "No profile loaded."
    const mem = memories.length
        ? memories
              .map(
                  (m, i) =>
                      `${i + 1}. Request: ${m.request} | Solution: ${m.solution} | What broke: ${m.what_broke} | Fix: ${m.fix} | Stack: ${m.stack} | Outcome: ${m.outcome}`
              )
              .join("\n")
        : "No past memories."
    return `You are ${id}, the memory agent for one forward-deployed client deployment.\n${p}\nPrivate deployment memory (never quote raw details, only lessons):\n${mem}`
}

export function formatTranscript(transcript: CouncilEvent[]): string {
    if (!transcript.length) return "(no messages yet)"
    return transcript.map(e => `[${e.type}] ${e.from}: ${e.text}`).join("\n")
}

export function respondPrompt(self: string, request: string, transcript: CouncilEvent[]) {
    return {
        system: `${self}\n\n${CONFIDENTIALITY_RULE}\n\nYou are in a live council of client agents helping an FDE decide how to build a request for one client.
Share the single most relevant lesson from YOUR deployment memory for this request.
Speak ONLY from your own memory: do not add general advice, caveats, or guesses about problems you did not experience. Other agents will cover their own experience.
If nothing in your memory is genuinely relevant, set "abstain": true and say "No relevant experience at this deployment." Never invent experience.

${OUTPUT_FORMAT}`,
        prompt: `Request: ${request}\n\nCouncil so far:\n${formatTranscript(transcript)}`
    }
}

export function challengePrompt(self: string, transcript: CouncilEvent[]) {
    return {
        system: `${self}\n\n${CONFIDENTIALITY_RULE}\n\nYou are in a live council of client agents. Read the discussion.
If your deployment memory CONTRADICTS a suggestion another agent made, push back: name that agent id and explain the risk from your experience.
If nothing contradicts your memory, briefly agree and say why.
Argue only from your own memory, not general knowledge. Disagreement is useful: if your experience differs, say so plainly.
Take any [fde] messages as hard constraints from the engineer.
Set "abstain": false.

${OUTPUT_FORMAT}`,
        prompt: `Council so far:\n${formatTranscript(transcript)}`
    }
}

export function planPrompt(self: string, transcript: CouncilEvent[], fdeConstraints: string[]) {
    return {
        system: `${self}\n\n${CONFIDENTIALITY_RULE}\n\nYou are the requesting client's agent. Write the final build plan for YOUR deployment.
Combine the lessons from the council, resolve disagreements using what matches your own stack, and obey every FDE constraint.
"text": a short plan of 3-5 numbered steps in one string, each step naming which agent id it came from in parentheses.
"cites": every agent id the plan relied on. Set "abstain": false.

${OUTPUT_FORMAT}`,
        prompt: `FDE constraints: ${fdeConstraints.length ? fdeConstraints.join("; ") : "none"}\n\nCouncil:\n${formatTranscript(transcript)}`
    }
}
