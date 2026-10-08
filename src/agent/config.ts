// The managed agent's definition (stage 9), and where its ids are kept.
//
// With the Messages API, model, system prompt and tools were request
// parameters, sent with every call. A Managed Agent stores them on Anthropic's
// side instead, as an *agent* object with an id. You create it once; every
// change after that adds a new numbered version. Sessions point at it.
//
// An *environment* is the template for the container where the agent's tools
// run: bash, file edits and code run there, not on your machine.
//
// Stage 10 moves the dataset out of the system prompt: each session mounts
// it as a file instead, and the agent writes its reports and charts to an
// outputs folder that your program downloads (see files.ts).

import type Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { MODEL } from "../client.ts";
import { toolInputSchemas, tools } from "../tools.ts";

// Where things are inside the session's container. Mounted files land under
// /mnt/session/uploads/ and are read-only. Whatever the agent writes to
// /mnt/session/outputs/ is captured and can be downloaded afterwards.
export const DATA_MOUNT = "/routes.json";
export const DATA_PATH = `/mnt/session/uploads${DATA_MOUNT}`;
export const OUTPUTS_DIR = "/mnt/session/outputs/";

export const environmentDefinition: Anthropic.Beta.Environments.EnvironmentCreateParams = {
  name: "route-analyst",
  config: {
    type: "cloud", // the container runs on Anthropic's infrastructure
    // No internet from the container, except package registries (pip, npm).
    // Web search and fetch aren't affected: they run on Anthropic's servers.
    networking: { type: "limited", allow_package_managers: true },
    // Installed in every new container of this environment, so the agent
    // doesn't have to pip install them at the start of each session.
    packages: { type: "packages", pip: ["pandas", "matplotlib"] },
  },
};

const instructions =
  "You are a route analyst for Rota Express, a delivery company. Dispatchers " +
  `ask you about today's planned routes. Today's route data is the JSON file ` +
  `${DATA_PATH}: it's your source of truth, so read it before answering. ` +
  "Refer to routes, vehicles and stops by ID, and show the numbers behind " +
  "each conclusion. Use the distance and evaluate_route tools for distances, " +
  "timings and totals, and to check a fix before recommending it, instead of " +
  "calculating them yourself. You also have a Linux workspace with bash, " +
  "Python (with pandas and matplotlib) and file tools, and web search for " +
  "real-world conditions in São Paulo on the service date, such as traffic, " +
  "weather or events. When the dispatcher asks for a report or a chart, save " +
  `it in ${OUTPUTS_DIR} (Markdown for reports, PNG for charts): files there ` +
  "are delivered to the dispatcher. If the data doesn't answer a question, " +
  "say so instead of guessing. Answer briefly and concretely.";

export const agentDefinition: Anthropic.Beta.Agents.AgentCreateParams = {
  name: "Route analyst",
  // The model can be an object, to set the effort the agent runs at.
  model: { id: MODEL, effort: "medium" },
  // The agent keeps its own system prompt. Prompt caching happens
  // automatically in sessions, so there are no cache markers to place. The
  // dataset isn't in it anymore: the agent reads the mounted file when it
  // needs the data, and can work through it with Python instead of holding
  // all of it in its context.
  system: instructions,
  tools: [
    // The prebuilt toolset: bash, read, write, edit, glob, grep, web_fetch and
    // web_search. Anthropic runs them: the file and shell tools in the
    // session's container, the web tools on its own servers.
    {
      type: "agent_toolset_20260401",
      default_config: { enabled: true },
      configs: [
        {
          name: "web_search",
          user_location: { type: "approximate", city: "São Paulo", country: "BR", timezone: "America/Sao_Paulo" },
        },
      ],
    },
    // Your own tools, declared as "custom" tools: just a name, a description
    // and a JSON Schema. When the agent calls one, the session pauses until
    // your program runs it and sends the result back (see session.ts).
    ...tools.map((tool) => ({
      type: "custom" as const,
      name: tool.name,
      description: "description" in tool ? (tool.description ?? "") : "",
      input_schema: jsonSchema(toolInputSchemas[tool.name]),
    })),
  ],
};

// A plain JSON Schema from a Zod schema, without the "$schema" header.
function jsonSchema(schema: z.ZodType) {
  const { $schema, ...rest } = z.toJSONSchema(schema);
  return rest as Anthropic.Beta.Agents.BetaManagedAgentsCustomToolInputSchema;
}

// The ids setup created. They belong to your Anthropic workspace, not to the
// code, so they live in a local file that git ignores.
export interface AgentState {
  environment_id: string;
  agent_id: string;
  agent_version: number;
  // Let setup tell whether a definition changed since it last ran.
  definition_hash: string;
  environment_hash?: string; // added in stage 10
}

const STATE_FILE = new URL("../../managed-agent.json", import.meta.url);

export function loadState(): AgentState | undefined {
  return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : undefined;
}

export function saveState(state: AgentState) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

export function definitionHash() {
  return hash(agentDefinition);
}

export function environmentHash() {
  return hash(environmentDefinition);
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
