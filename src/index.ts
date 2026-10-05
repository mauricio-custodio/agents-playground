// Route analyst: a terminal chat with Claude about today's delivery routes.
//
// Each stage of the roadmap in README.md adds one API concept. This file only
// wires the commands to the modules that implement them:
//
//   client.ts    the client, the model, and refusal fallbacks (stage 1)
//   chat.ts      history, streaming and thinking (stages 2-3)
//   prompt.ts    the system prompt and prompt caching (stage 4)
//   data.ts      loads data/routes.json (stage 4)
//   audit.ts     /audit, structured output with Zod (stage 5)
//   settings.ts  effort and the raw view, changed by commands
//   output.ts    printing raw JSON, usage and cost
//
// Run:  npm start   then type.
//   /audit           lists every problem in the data as structured JSON
//   /effort <level>  low | medium | high | xhigh | max (starts at low)
//   /raw             toggles printing the request JSON and every stream event (off by default)
//   /history         shows a summary of what gets sent
//   exit             quits (or Ctrl+D)

import * as readline from "node:readline";
import { audit } from "./audit.ts";
import { printHistory, turn } from "./chat.ts";
import { routeData } from "./data.ts";
import { setEffort, toggleRaw } from "./settings.ts";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let inputClosed = false; // Ctrl+D can close input while a request is in flight
rl.on("close", () => (inputClosed = true));

const { routes, unassigned } = routeData;
console.log(`Route analyst. Loaded ${routes.length} routes and ${unassigned.length} unassigned deliveries.`);
console.log("Commands: /audit, /effort <level>, /raw, /history, exit.");
rl.setPrompt("\nyou › ");
rl.prompt();

for await (const line of rl) {
  const text = line.trim();
  if (text === "exit") break;
  else if (text === "/history") printHistory();
  else if (text === "/audit") await audit();
  else if (text === "/raw") toggleRaw();
  else if (text.startsWith("/effort")) setEffort(text.split(/\s+/)[1]);
  else if (text) await turn(text);
  if (!inputClosed) rl.prompt();
}
rl.close();
