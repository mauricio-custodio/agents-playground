// Stage 1: one request, one response.
//
// Everything in the Claude API goes through a single endpoint: POST /v1/messages.
// You send a list of messages and get back one assistant message made of
// "content blocks". Tools, streaming, structured output and thinking are all
// options on this same request. Later stages only add to it.
//
// Run:  npm start -- "your question here"

import Anthropic from "@anthropic-ai/sdk";

// With no arguments the client reads ANTHROPIC_API_KEY from the environment
// (npm start loads it from .env).
const client = new Anthropic();

const question =
  process.argv.slice(2).join(" ") ||
  "In three bullet points: what makes a delivery route efficient?";

const response = await client.beta.messages.create({
  model: "claude-opus-5-5",

  // Hard cap on output tokens for this response. If it's hit, the answer is
  // cut off and stop_reason is "max_tokens". The model doesn't see this
  // number, so set it generously.
  max_tokens: 16000,

  // Opus 5.5 always thinks before it answers. Effort sets how much:
  // low | medium | high | xhigh | max. The default on this model is medium.
  // Try "low" and "high" and compare the output_tokens below.
  output_config: { effort: "low" },

  // The conversation so far. The API is stateless: it remembers nothing
  // between calls, so every request carries the full history.
  messages: [{ role: "user", content: question }],

  // A safety classifier can decline a request (HTTP 200 with
  // stop_reason "refusal"). With fallbacks on, the API retries on another
  // model inside the same call. This is a beta feature, which is why the
  // call goes through client.beta.messages instead of client.messages.
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
});

// Always check stop_reason before reading content.
if (response.stop_reason === "refusal") {
  console.error("Declined:", response.stop_details);
  process.exit(1);
}

// content is an array of blocks with different types. You'll usually get a
// "thinking" block (empty text by default) followed by a "text" block.
for (const block of response.content) {
  if (block.type === "text") console.log(block.text);
}

// What came back besides the text:
const { input_tokens, output_tokens } = response.usage;
const costUsd = (input_tokens * 4 + output_tokens * 20) / 1_000_000; // Opus 5.5: $4 / $20 per 1M tokens

console.log("\n--- under the hood ---");
console.log("model:      ", response.model);
console.log("stop_reason:", response.stop_reason);
console.log("blocks:     ", response.content.map((b) => b.type).join(", "));
console.log("tokens:     ", `${input_tokens} in / ${output_tokens} out (thinking counts as output)`);
console.log("cost:       ", `~$${costUsd.toFixed(4)}`);
