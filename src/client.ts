// The pieces every request shares: the client, the model, and refusal fallbacks.

import Anthropic from "@anthropic-ai/sdk";

// With no arguments the client reads ANTHROPIC_API_KEY from the environment
// (npm start loads it from .env).
export const client = new Anthropic();

export const MODEL = "claude-opus-5-5";

// A safety classifier can decline a request (HTTP 200 with stop_reason
// "refusal"). With fallbacks on, the API retries on another model inside the
// same call. This is a beta feature, which is why every request goes through
// client.beta.messages instead of client.messages.
export const fallbackParams = {
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
} satisfies Pick<Anthropic.Beta.Messages.MessageCreateParams, "betas" | "fallbacks">;
