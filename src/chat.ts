// Chat turns: the conversation history (stage 2), streaming and visible
// thinking (stage 3), caching the growing history (stage 4), and the tool
// loop (stage 6).
//
// The API is stateless: it doesn't remember anything between calls. A
// "conversation" is an array of messages that you keep and send in full on
// every request.
//
// With streaming, the API sends events while the response is being
// generated: message_start, then for each content block a start, many
// deltas and a stop, then message_delta (stop_reason and final usage) and
// message_stop. The SDK parses the events and also assembles the final
// message for you.

import Anthropic from "@anthropic-ai/sdk";
import { styleText } from "node:util";
import { client, fallbackParams, MODEL } from "./client.ts";
import { printRequest, printStreamEvents, printToolResults, printUsage, seconds } from "./output.ts";
import { system } from "./prompt.ts";
import { settings } from "./settings.ts";
import { runTool, tools } from "./tools.ts";

// The conversation history. It lives in your process; the API never stores it.
const messages: Anthropic.Beta.BetaMessageParam[] = [];
let turnCount = 0;

// Most questions need a few rounds of tool calls. The cap stops a confused
// loop from running up the bill.
const MAX_ROUNDS = 10;

export async function turn(userText: string) {
  // Where this turn starts, so a failed turn can be removed as a whole.
  const turnStart = messages.length;
  messages.push({ role: "user", content: userText });
  const timing = { startedAt: performance.now(), firstOutputAt: undefined as number | undefined };

  // The agentic loop: call the API. If Claude asked for tools, run them, send
  // the results back and call again. The turn ends when Claude answers
  // without asking for a tool.
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const response = await request(timing);
    if (!response) {
      // Drop the whole unfinished turn, tool calls included. Only this turn's
      // messages at the end are removed, so earlier turns stay untouched.
      messages.length = turnStart;
      return;
    }

    // Append the assistant's full content, not just its text. Opus 5.5 ties
    // each thinking block to the conversation that produced it, so blocks
    // must go back unchanged. Treat the history as append-only: if you edit
    // or delete an earlier turn, its thinking blocks become invalid, and
    // newer accounts get a 400 error. tool_use blocks must go back too: each
    // tool_result has to answer a tool_use in the message before it.
    const content = contentForHistory(response.content);
    messages.push({ role: "assistant", content });

    const calls = content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (response.stop_reason !== "tool_use") {
      // A tool call cut off by max_tokens can still look complete, so tools
      // only ever run when stop_reason is "tool_use".
      if (calls.length > 0) {
        console.error("\nA tool call was cut off (max_tokens), so this turn was dropped.");
        messages.length = turnStart;
        return;
      }
      turnCount++;
      const firstOutput = timing.firstOutputAt ? `${seconds(timing.firstOutputAt - timing.startedAt)} to first output, ` : "";
      const total = seconds(performance.now() - timing.startedAt);
      const cutOff = response.stop_reason === "max_tokens" ? " · CUT OFF (max_tokens)" : "";
      console.log(`\n[turn ${turnCount} · effort ${settings.effort} · ${round} requests · ${firstOutput}${total} total${cutOff}]`);
      return;
    }

    // Run every tool call in the response. Claude can ask for several at once
    // (parallel tool use): all the results go back together in one user
    // message, each matched to its call by tool_use_id.
    const results = calls.map(runTool);
    printToolResults(calls, results);
    messages.push({ role: "user", content: results });
  }

  console.error(`\nStopped after ${MAX_ROUNDS} requests without a final answer, so this turn was dropped.`);
  messages.length = turnStart;
}

// One streamed API call. Returns the complete message, or null if the call
// failed or was declined (the reason is printed).
async function request(timing: { firstOutputAt?: number }): Promise<Anthropic.Beta.BetaMessage | null> {
  const params: Anthropic.Beta.Messages.MessageCreateParams = {
    model: MODEL,

    // Hard cap on output tokens. A streaming connection stays active while
    // tokens arrive, so long responses don't hit HTTP timeouts. That's why the
    // cap can be much higher than for a non-streaming request.
    max_tokens: 64000,

    // Opus 5.5 always thinks; effort sets how much. Change it with /effort
    // and compare the thinking, output tokens and time. Changing it also
    // invalidates the cached history, so expect a cache write on that turn.
    output_config: { effort: settings.effort },

    // Thinking happens, and is billed, whatever `display` says. "summarized"
    // returns a readable summary of it. The default, "omitted", returns an
    // empty thinking text.
    thinking: { type: "adaptive", display: "summarized" },

    // The tools Claude may ask for. tool_choice defaults to "auto": Claude
    // decides whether to call any. (Opus 5.5 doesn't allow forcing a call.)
    tools,

    system, // instructions + dataset: the same bytes on every request
    messages, // the full history, every time

    // Breakpoint 2, automatic: the API puts a marker on the last block of the
    // request, so it moves forward as the conversation grows. Each turn then
    // also reads the previous turns from the cache and writes only what's new.
    cache_control: { type: "ephemeral" },

    ...fallbackParams,
  };

  if (settings.showRaw) printRequest(params, "  (stream: true)");

  for (let attempt = 1; ; attempt++) {
    const events: Anthropic.Beta.Messages.BetaRawMessageStreamEvent[] = [];
    let response: Anthropic.Beta.BetaMessage;
    try {
      // .stream() sets "stream": true in the body and returns an event iterator.
      const stream = client.beta.messages.stream(params);

      for await (const event of stream) {
        if (settings.showRaw) events.push(event);

        if (event.type === "content_block_start") {
          const block = event.content_block;
          if (block.type === "thinking") process.stdout.write(styleText("dim", "\nthinking › "));
          if (block.type === "text") process.stdout.write("\n\nclaude › ");
          if (block.type === "tool_use") process.stdout.write(styleText("cyan", `\n\ntool › ${block.name} `));
          if (block.type === "fallback") {
            process.stdout.write(styleText("yellow", `\n[${block.from.model} declined; ${block.to.model} continues]`));
          }
        } else if (event.type === "content_block_delta") {
          timing.firstOutputAt ??= performance.now();
          if (event.delta.type === "thinking_delta") process.stdout.write(styleText("dim", event.delta.thinking));
          if (event.delta.type === "text_delta") process.stdout.write(event.delta.text);
          // A tool's input arrives as fragments of JSON while Claude writes it.
          if (event.delta.type === "input_json_delta") process.stdout.write(styleText("dim", event.delta.partial_json));
        }
      }

      // The SDK has been assembling the events as they arrived. finalMessage()
      // returns the same message object a non-streaming request would.
      response = await stream.finalMessage();
    } catch (error) {
      // The SDK already retried rate limits (429) and server errors (5xx) twice
      // before throwing. Every error class extends Anthropic.APIError.
      if (error instanceof Anthropic.APIError) {
        console.error(`\nAPI error: ${error.message}`);
        return null;
      }
      // With eager input streaming the SDK parses each tool input itself and
      // throws if the JSON can't be parsed at all. The tool_use block never
      // completed, so there's no id to answer: the fix is to resend.
      if (error instanceof Anthropic.AnthropicError && attempt < 3) {
        console.error(`\n${error.message}\nRetrying the request…`);
        continue;
      }
      if (error instanceof Anthropic.AnthropicError) {
        console.error(`\n${error.message}`);
        return null;
      }
      throw error;
    }
    process.stdout.write("\n");

    if (settings.showRaw) printStreamEvents(events);
    printUsage(response.usage);

    // Always check stop_reason before using the content. A refusal can arrive
    // mid-stream, after part of an answer was already shown: discard that part.
    if (response.stop_reason === "refusal") {
      console.error("\nDeclined, so discard any partial answer above:", response.stop_details);
      return null;
    }
    return response;
  }
}

// When a stream falls back mid-answer, its content holds the declined
// model's partial output, then a "fallback" block, then the new model's
// answer. The declined model's thinking and tool_use blocks must not be sent
// back (so its tool calls aren't run either). Its text, and everything after
// the last fallback block, are fine to keep.
function contentForHistory(content: Anthropic.Beta.BetaContentBlock[]) {
  const boundary = content.findLastIndex((b) => b.type === "fallback");
  if (boundary === -1) return content;
  return content.filter((b, i) => i >= boundary || b.type === "text");
}

export function printHistory() {
  console.log(`\nEvery request sends the system prompt plus these ${messages.length} messages:`);
  messages.forEach((m, i) => {
    const blocks = typeof m.content === "string" ? ["text"] : m.content.map((b) => b.type);
    console.log(`  ${String(i + 1).padStart(2)}. ${m.role.padEnd(9)} ${blocks.join(", ")}`);
  });
}
