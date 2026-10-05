// Stage 3: streaming and visible thinking.
//
// Until now the whole answer arrived in one piece after Claude finished.
// With streaming, the API sends events while the response is being
// generated: message_start, then for each content block a start, many
// deltas and a stop, then message_delta (stop_reason and final usage) and
// message_stop. The SDK parses the events and also assembles the final
// message for you, so the history works exactly as in stage 2.
//
// Run:  npm start   then type.
//   /effort <level>  low | medium | high | xhigh | max (starts at low)
//   /raw             toggles printing the request JSON and every stream event (on by default)
//   /history         shows a summary of what gets sent
//   exit             quits (or Ctrl+D)

import Anthropic from "@anthropic-ai/sdk";
import * as readline from "node:readline";
import { styleText } from "node:util";

// With no arguments the client reads ANTHROPIC_API_KEY from the environment
// (npm start loads it from .env).
const client = new Anthropic();

// The system prompt sets Claude's role and rules for the whole conversation.
// It's a separate field, not a message, and like the history it's sent with
// every request.
const system =
  "You are a route analyst for a small delivery company. You help dispatchers " +
  "plan and review delivery routes: stop order, time windows, drive time, " +
  "vehicle capacity. Answer briefly and concretely. If a question needs data " +
  "you don't have, say what data you'd need.";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];

// The conversation history. It lives in your process; the API never stores it.
const messages: Anthropic.Beta.BetaMessageParam[] = [];
let conversationCostUsd = 0;
let showRaw = true;
let effort: Effort = "low";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let inputClosed = false; // Ctrl+D can close input while a request is in flight
rl.on("close", () => (inputClosed = true));
console.log("Route analyst. Commands: /effort <level>, /raw, /history, exit.");
rl.setPrompt("\nyou › ");
rl.prompt();

for await (const line of rl) {
  const text = line.trim();
  if (text === "exit") break;
  else if (text === "/history") printHistory();
  else if (text === "/raw") console.log(`raw view ${(showRaw = !showRaw) ? "on" : "off"}`);
  else if (text.startsWith("/effort")) setEffort(text.split(/\s+/)[1]);
  else if (text) await turn(text);
  if (!inputClosed) rl.prompt();
}
rl.close();

async function turn(userText: string) {
  messages.push({ role: "user", content: userText });

  const request: Anthropic.Beta.Messages.MessageCreateParams = {
    model: "claude-opus-5-5",

    // Hard cap on output tokens. A streaming connection stays active while
    // tokens arrive, so long responses don't hit HTTP timeouts. That's why the
    // cap can be much higher than for a non-streaming request.
    max_tokens: 64000,

    // Opus 5.5 always thinks; effort sets how much. Change it with /effort
    // and compare the thinking, output tokens and time.
    output_config: { effort },

    // Thinking happens, and is billed, whatever `display` says. "summarized"
    // returns a readable summary of it. The default, "omitted", returns the
    // empty thinking text you saw in stage 2.
    thinking: { type: "adaptive", display: "summarized" },

    system,
    messages, // the full history, every time

    // A safety classifier can decline a request (HTTP 200 with
    // stop_reason "refusal"). With fallbacks on, the API retries on another
    // model inside the same call. This is a beta feature, which is why the
    // call goes through client.beta.messages instead of client.messages.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  };

  if (showRaw) {
    // `betas` isn't part of the JSON body: the SDK sends it as the
    // anthropic-beta HTTP header. Everything else is the body as sent.
    const { betas, ...body } = request;
    printRaw(`→ POST /v1/messages  (stream: true)   anthropic-beta: ${betas?.join(",")}`, body);
  }

  const events: Anthropic.Beta.Messages.BetaRawMessageStreamEvent[] = [];
  const startedAt = performance.now();
  let firstOutputAt: number | undefined;
  let response: Anthropic.Beta.BetaMessage;
  try {
    // .stream() sets "stream": true in the body and returns an event iterator.
    const stream = client.beta.messages.stream(request);

    for await (const event of stream) {
      if (showRaw) events.push(event);

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

  if (showRaw) {
    console.log(styleText("cyan", `\n← ${events.length} stream events`));
    for (const event of events) console.log(styleText("dim", JSON.stringify(event)));
  }

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

  const { input_tokens, output_tokens } = response.usage;
  const costUsd = (input_tokens * 4 + output_tokens * 20) / 1_000_000; // Opus 5.5: $4 / $20 per 1M tokens
  conversationCostUsd += costUsd;

  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const timing = firstOutputAt
    ? `${seconds(firstOutputAt - startedAt)} to first output, ${seconds(finishedAt - startedAt)} total`
    : `${seconds(finishedAt - startedAt)} total`;
  const cutOff = response.stop_reason === "max_tokens" ? " · CUT OFF (max_tokens)" : "";
  console.log(
    `\n[turn ${messages.length / 2} · effort ${effort} · ${timing} · ` +
      `${input_tokens} in / ${output_tokens} out · ~$${costUsd.toFixed(4)} ` +
      `(conversation ~$${conversationCostUsd.toFixed(4)})${cutOff}]`,
  );
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

function setEffort(value: string | undefined) {
  if (EFFORTS.includes(value as Effort)) effort = value as Effort;
  else if (value) console.log(`unknown effort "${value}"`);
  console.log(`effort: ${effort}  (options: ${EFFORTS.join(", ")})`);
}

function printRaw(label: string, value: unknown) {
  console.log(styleText("cyan", `\n${label}`));
  console.log(styleText("dim", JSON.stringify(value, null, 2)));
}

function printHistory() {
  console.log(`\nEvery request sends the system prompt plus these ${messages.length} messages:`);
  messages.forEach((m, i) => {
    const blocks = typeof m.content === "string" ? ["text"] : m.content.map((b) => b.type);
    console.log(`  ${String(i + 1).padStart(2)}. ${m.role.padEnd(9)} ${blocks.join(", ")}`);
  });
}
