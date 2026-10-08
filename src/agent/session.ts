// One turn with the managed agent (stage 9): send a message, then follow the
// session's events until the agent is done.
//
// With the Messages API, a turn was a request and its streamed response, you
// resent the whole history each time, and your code ran the tool loop. A
// session is different: it lives on Anthropic's side, keeps the conversation
// itself, and runs the agent loop for you. You send events in (here a
// user.message) and read events out: messages, tool calls and their results,
// status changes. Nothing is resent.

import Anthropic from "@anthropic-ai/sdk";
import { runRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { styleText } from "node:util";
import { client } from "../client.ts";
import { printRaw, seconds } from "../output.ts";
import { settings } from "../settings.ts";
import { tools } from "../tools.ts";

type SessionEvent = Anthropic.Beta.Sessions.BetaManagedAgentsStreamSessionEvents;

export async function runTurn(sessionId: string, text: string) {
  const startedAt = performance.now();
  const usage = { requests: 0, input: 0, output: 0, cacheRead: 0 };

  // Stream first. The stream only delivers events from the moment it opens,
  // so open it before sending, or the first events of the turn are missed.
  const stream = await client.beta.sessions.events.stream(sessionId);
  await client.beta.sessions.events.send(sessionId, {
    events: [{ type: "user.message", content: [{ type: "text", text }] }],
  });

  for await (const event of stream) {
    if (settings.showRaw) printRaw(`← ${event.type}`, event);
    showEvent(event);

    if (event.type === "agent.custom_tool_use") await answerCustomTool(sessionId, event);

    // Each model request the agent makes ends with its token usage.
    if (event.type === "span.model_request_end") {
      usage.requests++;
      usage.input += event.model_usage.input_tokens + event.model_usage.cache_creation_input_tokens;
      usage.cacheRead += event.model_usage.cache_read_input_tokens;
      usage.output += event.model_usage.output_tokens;
    }

    if (event.type === "session.status_terminated") {
      console.error("\nThe session ended and can't be used anymore.");
      return;
    }
    if (event.type === "session.status_idle") {
      // Idle doesn't always mean done. "requires_action" means the session is
      // waiting on you: here, for the result of a custom tool, which
      // answerCustomTool() has already sent or is about to.
      if (event.stop_reason.type === "requires_action") continue;
      if (event.stop_reason.type === "budget_reached") console.error("\nThe session reached its spending cap and paused.");
      if (event.stop_reason.type === "retries_exhausted") console.error("\nThe agent gave up after repeated errors.");
      if (event.stop_reason.type === "refusal") console.error("\nDeclined:", event.stop_details);
      break; // end_turn: the agent has answered
    }
  }

  // The session tracks what it has cost so far, priced at list rates. That
  // includes the container's running time, not just tokens.
  const session = await client.beta.sessions.retrieve(sessionId);
  const cost = session.usage.list_cost ? `$${(Number(session.usage.list_cost.amount) / 100).toFixed(2)}` : "n/a";
  console.log(
    `\n[${usage.requests} model requests · ${usage.input} in + ${usage.cacheRead} cache read / ${usage.output} out · ` +
      `${seconds(performance.now() - startedAt)} · session so far ${cost}]`,
  );
}

// Custom tools run here, in your program, not in the container. The agent
// asks with an agent.custom_tool_use event, and the session waits until a
// user.custom_tool_result event answers it.
async function answerCustomTool(
  sessionId: string,
  event: Anthropic.Beta.Sessions.BetaManagedAgentsAgentCustomToolUseEvent,
) {
  const tool = tools.find((t) => t.name === event.name);
  // runRunnableTool is the step the tool runner does for each call: check the
  // input against the tool's Zod schema, run it, and turn a thrown error into
  // an error result.
  const outcome = tool
    ? await runRunnableTool(tool, event.input, { toolUse: event, toolUseBlock: event })
    : { content: `Unknown tool ${event.name}`, isError: true };
  const resultText = typeof outcome.content === "string" ? outcome.content : JSON.stringify(outcome.content);
  console.log(styleText(outcome.isError ? "red" : "dim", `  ↳ ${clip(resultText, 300)}`));

  await client.beta.sessions.events.send(sessionId, {
    events: [
      {
        type: "user.custom_tool_result",
        custom_tool_use_id: event.id, // the event's id (sevt_…), not a toolu_ id
        content: [{ type: "text", text: resultText }],
        is_error: outcome.isError,
      },
    ],
  });
}

function showEvent(event: SessionEvent) {
  switch (event.type) {
    case "agent.thinking":
      // Only a signal that the agent is thinking: sessions don't return the
      // thinking text, not even a summary.
      console.log(styleText("dim", "\nthinking…"));
      break;
    case "agent.message":
      // A whole message at once. Sessions send buffered messages by default;
      // live text previews are an opt-in on the stream (event_deltas).
      for (const block of event.content) if (block.type === "text") console.log(`\nagent › ${block.text}`);
      break;
    case "agent.tool_use":
      // A prebuilt tool. It runs in the container (or, for web tools, on
      // Anthropic's servers): nothing for your code to do.
      console.log(styleText("magenta", `\ntool › ${event.name}`) + styleText("dim", ` ${describeInput(event.input)}`));
      break;
    case "agent.tool_result": {
      const text = (event.content ?? []).map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join(" ");
      console.log(styleText(event.is_error ? "red" : "dim", `  ↳ ${clip(text, 300)}`));
      break;
    }
    case "agent.custom_tool_use":
      console.log(styleText("cyan", `\ncustom tool › ${event.name}`) + styleText("dim", ` ${JSON.stringify(event.input)}`));
      break;
    case "session.error":
      console.error(styleText("red", `\nsession error: ${event.error.message}`));
      break;
  }
}

// The most telling part of a prebuilt tool's input: the command, the file,
// the pattern, the search query or the URL.
function describeInput(input: Record<string, unknown>) {
  const key = ["command", "file_path", "pattern", "query", "url"].find((k) => typeof input[k] === "string");
  return clip(key ? String(input[key]) : JSON.stringify(input), 200);
}

const clip = (text: string, max: number) => {
  const oneLine = text.replace(/\s+/g, " ");
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
};
