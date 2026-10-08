// npm run agent:setup: creates the environment and the agent, once.
//
// Run it again after changing the definition in config.ts. Instead of
// creating another agent, it updates the existing one, which gets a new
// version number. Sessions already running keep the version they started on.
// Creating a new agent on every run is the classic mistake: it piles up
// copies and throws away the version history.
//
// (For real projects, Anthropic's `ant` CLI can keep agents and environments
// as version-controlled files and sync them with `ant apply`. This script
// does the same job through the SDK, so you can see each call.)

import Anthropic from "@anthropic-ai/sdk";
import { client } from "../client.ts";
import { agentDefinition, definitionHash, environmentDefinition, loadState, saveState } from "./config.ts";

try {
  const state = loadState();
  const hash = definitionHash();

  // Environment names are unique within a workspace, so look for ours first.
  let environment: Anthropic.Beta.Environments.BetaEnvironment | undefined;
  for await (const existing of client.beta.environments.list()) {
    if (existing.name === environmentDefinition.name && !existing.archived_at) environment = existing;
  }
  if (environment) {
    console.log(`environment ${environment.id} already exists`);
  } else {
    environment = await client.beta.environments.create(environmentDefinition);
    console.log(`created environment ${environment.id}`);
  }

  let agentId = state?.agent_id;
  let version = state?.agent_version;
  if (!agentId || !version) {
    const agent = await client.beta.agents.create(agentDefinition);
    agentId = agent.id;
    version = agent.version;
    console.log(`created agent ${agent.id}, version ${agent.version}`);
  } else if (state?.definition_hash !== hash) {
    // Passing the version you last saw makes the update conditional: it fails
    // with 409 if the agent changed since (in the Console, say).
    const agent = await client.beta.agents.update(agentId, { ...agentDefinition, version });
    version = agent.version;
    console.log(`updated agent ${agentId} to version ${agent.version}`);
  } else {
    console.log(`agent ${agentId} is up to date (version ${version})`);
  }

  saveState({ environment_id: environment.id, agent_id: agentId, agent_version: version, definition_hash: hash });
  console.log("Saved the ids to managed-agent.json. Start a session with: npm run agent");
} catch (error) {
  if (!(error instanceof Anthropic.APIError)) throw error;
  console.error(`API error: ${error.message}`);
  process.exitCode = 1;
}
