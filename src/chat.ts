// Chat turns: the conversation history (stage 2), streaming and visible
// thinking (stage 3), caching the growing history (stage 4), and the tool
// loop (stage 6), now run by the SDK's tool runner (stage 7).
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
import { tools } from "./tools.ts";

// The conversation history. It lives in your process; the API never stores it.
const messages: Anthropic.Beta.BetaMessageParam[] = [];
let turnCount = 0;

// Most questions need a few rounds of tool calls. The cap stops a confused
// loop from running up the bill.
const MAX_ROUNDS = 10;

export async function turn(userText: string) {
  const timing = { startedAt: performance.now(), firstOutputAt: undefined as number | undefined };
  let rounds = 0;

  // The tool runner is the stage 6 loop, packaged by the SDK. It sends a
  // request; if Claude asked for tools, it runs them (in parallel), sends all
  // the results back in one message, and sends again, until Claude answers
  // without a tool call. It works on its own copy of the messages, so a turn
  // that fails partway never touches the history.
  let runner = client.beta.messages.toolRunner({
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
    messages: [...messages, { role: "user", content: userText }],

    // Breakpoint 2, automatic: the API puts a marker on the last block of the
    // request, so it moves forward as the conversation grows. Each turn then
    // also reads the previous turns from the cache and writes only what's new.
    cache_control: { type: "ephemeral" },

    ...fallbackParams,

    stream: true, // each iteration hands you a stream instead of a finished message
    max_iterations: MAX_ROUNDS, // at most this many requests
  });

  for (let attempt = 1; ; attempt++) {
    try {
      // One iteration per API request. The runner hands you each response
      // before it acts on it, so the loop body can show it, check it, or
      // change what happens next.
      for await (const stream of runner) {
        rounds++;
        printLastToolResults(runner.params.messages);
        if (settings.showRaw) {
          const { max_iterations, ...sent } = runner.params;
          printRequest(sent as Anthropic.Beta.Messages.MessageCreateParams);
        }

        const events: Anthropic.Beta.Messages.BetaRawMessageStreamEvent[] = [];
        for await (const event of stream) {
          if (settings.showRaw) events.push(event);
          showEvent(event, timing);
        }
        const message = await stream.finalMessage();
        process.stdout.write("\n");
        if (settings.showRaw) printStreamEvents(events);
        printUsage(message.usage);

        // Stepping in: after a mid-answer fallback, hand the runner the
        // cleaned-up response instead. pushMessages() tells it you've taken
        // over this turn's history, so it runs the tool calls of your version.
        if (message.stop_reason === "tool_use" && message.content.some((b) => b.type === "fallback")) {
          runner.pushMessages({ role: "assistant", content: contentForHistory(message.content) });
        }
      }
      break;
    } catch (error) {
      // The SDK already retried rate limits (429) and server errors (5xx) twice
      // before throwing. Every error class extends Anthropic.APIError.
      if (error instanceof Anthropic.APIError) {
        console.error(`\nAPI error: ${error.message}`);
        return;
      }
      // With eager input streaming the SDK parses each tool input itself and
      // throws if the JSON can't be parsed at all. A used runner can't be
      // iterated again, so build a new one from runner.params: it holds the
      // conversation so far, without the failed response, so it resends it.
      if (error instanceof Anthropic.AnthropicError && attempt < 3) {
        console.error(`\n${error.message}\nRetrying the request…`);
        runner = client.beta.messages.toolRunner({ ...runner.params });
        continue;
      }
      if (error instanceof Anthropic.AnthropicError) {
        console.error(`\n${error.message}`);
        return;
      }
      throw error;
    }
  }

  // The runner stops on its own at any stop_reason other than "tool_use", and
  // never runs tools after max_tokens or a refusal. Deciding what that stop
  // means for your app is still up to you.
  const final = await runner.done();
  if (final.stop_reason === "refusal") {
    console.error("\nDeclined, so discard any partial answer above:", final.stop_details);
    return;
  }
  if (final.stop_reason === "tool_use") {
    console.error(`\nStopped after ${MAX_ROUNDS} requests without a final answer, so this turn was dropped.`);
    return;
  }
  // A tool call cut off by max_tokens is left without a result, and the API
  // rejects a history like that.
  if (final.content.some((b) => b.type === "tool_use")) {
    console.error("\nA tool call was cut off (max_tokens), so this turn was dropped.");
    return;
  }

  // Copy the finished turn into the history: everything in the runner's
  // conversation after what the history already had. That includes Claude's
  // full content (thinking blocks too: Opus 5.5 ties each one to the
  // conversation that produced it, so they go back unchanged) and every
  // tool_use / tool_result pair. The history is only ever appended to.
  const turnMessages = runner.params.messages.slice(messages.length);
  turnMessages[turnMessages.length - 1] = { role: "assistant", content: contentForHistory(final.content) };
  messages.push(...turnMessages);

  turnCount++;
  const firstOutput = timing.firstOutputAt ? `${seconds(timing.firstOutputAt - timing.startedAt)} to first output, ` : "";
  const total = seconds(performance.now() - timing.startedAt);
  const cutOff = final.stop_reason === "max_tokens" ? " · CUT OFF (max_tokens)" : "";
  console.log(`\n[turn ${turnCount} · effort ${settings.effort} · ${rounds} requests · ${firstOutput}${total} total${cutOff}]`);
}

function showEvent(event: Anthropic.Beta.Messages.BetaRawMessageStreamEvent, timing: { firstOutputAt?: number }) {
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

// The runner runs the tools between iterations and appends the results to
// its conversation. So at the start of an iteration, the last two messages
// are the previous round's tool calls and their results.
function printLastToolResults(conversation: Anthropic.Beta.BetaMessageParam[]) {
  if (conversation.length < 2) return;
  const [calls, results] = conversation.slice(-2);
  if (typeof calls.content === "string" || typeof results.content === "string") return;
  const toolUses = calls.content.filter((b) => b.type === "tool_use");
  const toolResults = results.content.filter((b) => b.type === "tool_result");
  if (toolResults.length > 0) printToolResults(toolUses, toolResults);
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
