// Chat turns: the conversation history (stage 2), streaming and visible
// thinking (stage 3), and caching the growing history (stage 4).
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
import { printRequest, printStreamEvents, printUsage, seconds } from "./output.ts";
import { system } from "./prompt.ts";
import { settings } from "./settings.ts";

// The conversation history. It lives in your process; the API never stores it.
const messages: Anthropic.Beta.BetaMessageParam[] = [];

export async function turn(userText: string) {
  messages.push({ role: "user", content: userText });

  const request: Anthropic.Beta.Messages.MessageCreateParams = {
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

    system, // instructions + dataset: the same bytes on every request
    messages, // the full history, every time

    // Breakpoint 2, automatic: the API puts a marker on the last block of the
    // request, so it moves forward as the conversation grows. Each turn then
    // also reads the previous turns from the cache and writes only what's new.
    cache_control: { type: "ephemeral" },

    ...fallbackParams,
  };

  if (settings.showRaw) printRequest(request, "  (stream: true)");

  const events: Anthropic.Beta.Messages.BetaRawMessageStreamEvent[] = [];
  const startedAt = performance.now();
  let firstOutputAt: number | undefined;
  let response: Anthropic.Beta.BetaMessage;
  try {
    // .stream() sets "stream": true in the body and returns an event iterator.
    const stream = client.beta.messages.stream(request);

    for await (const event of stream) {
      if (settings.showRaw) events.push(event);

      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block.type === "thinking") process.stdout.write(styleText("dim", "\nthinking › "));
        if (block.type === "text") process.stdout.write("\n\nclaude › ");
        if (block.type === "fallback") {
          process.stdout.write(styleText("yellow", `\n[${block.from.model} declined; ${block.to.model} continues]`));
        }
      } else if (event.type === "content_block_delta") {
        firstOutputAt ??= performance.now();
        if (event.delta.type === "thinking_delta") process.stdout.write(styleText("dim", event.delta.thinking));
        if (event.delta.type === "text_delta") process.stdout.write(event.delta.text);
      }
    }

    // The SDK has been assembling the events as they arrived. finalMessage()
    // returns the same message object a non-streaming request would.
    response = await stream.finalMessage();
  } catch (error) {
    // The SDK already retried rate limits (429) and server errors (5xx) twice
    // before throwing. Every error class extends Anthropic.APIError.
    if (!(error instanceof Anthropic.APIError)) throw error;
    console.error(`\nAPI error: ${error.message}`);
    messages.pop(); // forget the unanswered question so you can retry it
    return;
  }
  const finishedAt = performance.now();
  process.stdout.write("\n");

  if (settings.showRaw) printStreamEvents(events);

  // Always check stop_reason before using the content. A refusal can arrive
  // mid-stream, after part of an answer was already shown: discard that part.
  if (response.stop_reason === "refusal") {
    console.error("\nDeclined, so discard any partial answer above:", response.stop_details);
    messages.pop();
    return;
  }

  // Append the assistant's full content, not just its text. Opus 5.5 ties each
  // thinking block to the conversation that produced it, so blocks must go
  // back unchanged. Treat the history as append-only: if you edit or delete
  // an earlier turn, its thinking blocks become invalid, and newer accounts
  // get a 400 error.
  messages.push({ role: "assistant", content: contentForHistory(response.content) });

  const timing = firstOutputAt
    ? `${seconds(firstOutputAt - startedAt)} to first output, ${seconds(finishedAt - startedAt)} total`
    : `${seconds(finishedAt - startedAt)} total`;
  const cutOff = response.stop_reason === "max_tokens" ? " · CUT OFF (max_tokens)" : "";
  console.log(`\n[turn ${messages.length / 2} · effort ${settings.effort} · ${timing}${cutOff}]`);
  printUsage(response.usage);
}

// When a stream falls back mid-answer, its content holds the declined
// model's partial output, then a "fallback" block, then the new model's
// answer. The declined model's thinking blocks must not be sent back. Its
// text, and everything after the last fallback block, are fine to keep.
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
