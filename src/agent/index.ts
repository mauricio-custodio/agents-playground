// The route analyst as a Managed Agent (Part 3 of the roadmap).
//
//   npm run agent:setup   creates the environment and the agent (run once,
//                         and again after changing config.ts)
//   npm run agent         starts a session and chats with it
//   npm run agent:outputs <session id>
//                         downloads a session's output files again
//
//   config.ts   the agent and environment definitions, and the saved ids
//   setup.ts    creates or updates them (stage 9)
//   session.ts  one turn: send a message, follow the session's events (stage 9)
//   files.ts    the dataset mounted in, reports and charts downloaded out (stage 10)
//   outputs.ts  the agent:outputs command (stage 10)
//   outcome.ts  /report: a deliverable with a rubric, checked by a grader (stage 11)
//   index.ts    this chat loop: one session per run
//
// Commands: /report asks for the problems report as an outcome; /raw toggles
// printing every event as JSON; exit quits (or Ctrl+D).

import Anthropic from "@anthropic-ai/sdk";
import * as readline from "node:readline";
import { client } from "../client.ts";
import { toggleRaw } from "../settings.ts";
import { definitionHash, environmentHash, loadState } from "./config.ts";
import { routeDataResource } from "./files.ts";
import { reportOutcome } from "./outcome.ts";
import { runTurn } from "./session.ts";

const state = loadState();
if (!state) {
  console.error("No agent yet. Create it first with: npm run agent:setup");
  process.exit(1);
}
// The session uses the agent as setup last saved it, not config.ts as it is now.
if (state.definition_hash !== definitionHash() || state.environment_hash !== environmentHash()) {
  console.warn("config.ts changed since the last setup. Run npm run agent:setup to update the agent.");
}

// A session is one run of the agent: its own container, conversation and
// event log. It points at the agent by id, and here pins the version setup
// saved, so changing the agent later doesn't affect this session.
let session: Anthropic.Beta.Sessions.BetaManagedAgentsSession;
try {
  session = await client.beta.sessions.create({
    agent: { type: "agent", id: state.agent_id, version: state.agent_version },
    environment_id: state.environment_id,
    title: "Route analyst chat",
    // Files, repositories or memory stores to attach to the container. They
    // are checked when the session is created, so a bad file id fails here.
    resources: [await routeDataResource()],
    // A hard spending cap, at list prices, in cents: "500" is $5.00. At the
    // cap the session pauses instead of spending more. (An outcome can take
    // several rounds of work plus grading, so it needs more room than a chat.)
    budget: { type: "limit", max_list_cost: { amount: "500", currency: "USD" } },
  });
} catch (error) {
  if (!(error instanceof Anthropic.APIError)) throw error;
  console.error(`Couldn't start a session: ${error.message}`);
  process.exit(1);
}

console.log(`Route analyst (managed agent ${state.agent_id}, version ${state.agent_version}).`);
console.log(`Session ${session.id}. Watch it live in the Console:`);
// "default" is the Default workspace. If your API key belongs to another
// workspace, put that workspace's id there instead.
console.log(`https://platform.claude.com/workspaces/default/sessions/${session.id}`);
console.log("Commands: /report, /raw, exit.");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let inputClosed = false; // Ctrl+D can close input while a turn is running
rl.on("close", () => (inputClosed = true));
rl.setPrompt("\nyou › ");
rl.prompt();

for await (const line of rl) {
  const text = line.trim();
  if (text === "exit") break;
  else if (text === "/raw") toggleRaw();
  else if (text === "/report") await turn(reportOutcome());
  else if (text) await turn({ type: "user.message", content: [{ type: "text", text }] });
  if (!inputClosed) rl.prompt();
}
rl.close();
await archive(session.id);

async function turn(kickoff: Anthropic.Beta.Sessions.BetaManagedAgentsEventParams) {
  try {
    await runTurn(session.id, kickoff);
  } catch (error) {
    if (!(error instanceof Anthropic.APIError)) throw error;
    console.error(`\nAPI error: ${error.message}`);
  }
}

// Sessions are disposable: archiving one makes it read-only (you can still
// open it in the Console) and frees its container. Agents and environments
// are the opposite: never archive those as cleanup, since it's permanent.
async function archive(sessionId: string) {
  try {
    // The session can report "running" for a moment after going idle, and
    // archiving a running session fails, so wait for it to settle first.
    for (let i = 0; i < 10; i++) {
      if ((await client.beta.sessions.retrieve(sessionId)).status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await client.beta.sessions.archive(sessionId);
    console.log(`Archived session ${sessionId}.`);
  } catch (error) {
    if (!(error instanceof Anthropic.APIError)) throw error;
    console.error(`Couldn't archive the session: ${error.message}`);
  }
}
