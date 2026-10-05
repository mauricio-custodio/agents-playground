// Stage 2: a multi-turn chat.
//
// The API is stateless: it doesn't remember anything between calls. A
// "conversation" is an array of messages that you keep and send in full on
// every request. Watch the input tokens grow each turn: that's the whole
// history being sent, and paid for, again.
//
// Run:  npm start   then type.
//   /raw      toggles printing the exact request and response JSON (on by default)
//   /history  shows a summary of what gets sent
//   exit      quits (or Ctrl+D)

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

// The conversation history. It lives in your process; the API never stores it.
const messages: Anthropic.Beta.BetaMessageParam[] = [];
let conversationCostUsd = 0;
let showRaw = true;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let inputClosed = false; // Ctrl+D can close input while a request is in flight
rl.on("close", () => (inputClosed = true));
console.log('Route analyst. Commands: /raw, /history, exit.');
rl.setPrompt("\nyou › ");
rl.prompt();

for await (const line of rl) {
  const text = line.trim();
  if (text === "exit") break;
  else if (text === "/history") printHistory();
  else if (text === "/raw") console.log(`raw view ${(showRaw = !showRaw) ? "on" : "off"}`);
  else if (text) await turn(text);
  if (!inputClosed) rl.prompt();
}
rl.close();

async function turn(userText: string) {
  messages.push({ role: "user", content: userText });

  const request: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming = {
    model: "claude-opus-5-5",

    // Hard cap on output tokens for this response. If it's hit, the answer is
    // cut off and stop_reason is "max_tokens". The model doesn't see this
    // number, so set it generously.
    max_tokens: 16000,

    // Opus 5.5 always thinks before it answers. Effort sets how much:
    // low | medium | high | xhigh | max. The default on this model is medium.
    output_config: { effort: "low" },

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
    printRaw(`→ POST /v1/messages   anthropic-beta: ${betas?.join(",")}`, body);
  }

  let response: Anthropic.Beta.BetaMessage;
  try {
    response = await client.beta.messages.create(request);
  } catch (error) {
    // The SDK already retried rate limits (429) and server errors (5xx) twice
    // before throwing. Every error class extends Anthropic.APIError.
    if (!(error instanceof Anthropic.APIError)) throw error;
    console.error(`\nAPI error: ${error.message}`);
    messages.pop(); // forget the unanswered question so you can retry it
    return;
  }

  // The SDK returns the response body parsed into a typed object.
  if (showRaw) printRaw("← 200 response body", response);

  // Always check stop_reason before reading content.
  if (response.stop_reason === "refusal") {
    console.error("\nDeclined:", response.stop_details);
    messages.pop();
    return;
  }

  // Append the assistant's full content, not just its text. Opus 5.5 ties each
  // thinking block to the conversation that produced it, so blocks must go
  // back unchanged. Treat the history as append-only: if you edit or delete
  // an earlier turn, its thinking blocks become invalid, and newer accounts
  // get a 400 error.
  messages.push({ role: "assistant", content: response.content });

  for (const block of response.content) {
    if (block.type === "text") console.log(`\nclaude › ${block.text}`);
  }

  const { input_tokens, output_tokens } = response.usage;
  const costUsd = (input_tokens * 4 + output_tokens * 20) / 1_000_000; // Opus 5.5: $4 / $20 per 1M tokens
  conversationCostUsd += costUsd;

  const turnNumber = messages.length / 2;
  const cutOff = response.stop_reason === "max_tokens" ? " · CUT OFF (max_tokens)" : "";
  console.log(
    `\n[turn ${turnNumber} · ${input_tokens} in / ${output_tokens} out · ` +
      `~$${costUsd.toFixed(4)} · conversation ~$${conversationCostUsd.toFixed(4)}${cutOff}]`,
  );
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
