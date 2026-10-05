// Terminal output shared by chat turns and /audit: raw JSON, usage and cost.

import type Anthropic from "@anthropic-ai/sdk";
import { styleText } from "node:util";

let sessionCostUsd = 0;

export function printRequest(request: Anthropic.Beta.Messages.MessageCreateParams, note = "") {
  // `betas` isn't part of the JSON body: the SDK sends it as the
  // anthropic-beta HTTP header. Everything else is the body as sent.
  const { betas, ...body } = request;
  printRaw(`→ POST /v1/messages${note}   anthropic-beta: ${betas?.join(",")}`, body);
}

export function printStreamEvents(events: Anthropic.Beta.Messages.BetaRawMessageStreamEvent[]) {
  console.log(styleText("cyan", `\n← ${events.length} stream events`));
  for (const event of events) console.log(styleText("dim", JSON.stringify(event)));
}

export function printRaw(label: string, value: unknown) {
  // Very long strings, like the dataset, are cut short on screen only. The
  // API always receives them in full.
  const shorten = (_key: string, v: unknown) =>
    typeof v === "string" && v.length > 2000 ? `${v.slice(0, 300)} … [${v.length - 300} more characters not shown]` : v;
  console.log(styleText("cyan", `\n${label}`));
  console.log(styleText("dim", JSON.stringify(value, shorten, 2)));
}

export function printUsage(usage: Anthropic.Beta.BetaUsage) {
  // With caching, the prompt's tokens are split three ways. input_tokens is
  // only the part after the last cache hit, not the whole prompt.
  const { input_tokens, output_tokens } = usage;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const promptTokens = cacheRead + cacheWrite + input_tokens;

  // Opus 5.5 prices per 1M tokens: input $4, cache write (5 minutes) $5,
  // cache read $0.20, output $20.
  const costUsd = (input_tokens * 4 + cacheWrite * 5 + cacheRead * 0.2 + output_tokens * 20) / 1_000_000;
  const uncachedUsd = (promptTokens * 4 + output_tokens * 20) / 1_000_000;
  sessionCostUsd += costUsd;

  console.log(
    `[prompt ${promptTokens} = ${cacheRead} cache read + ${cacheWrite} cache write + ${input_tokens} uncached · ` +
      `${output_tokens} out · ~$${costUsd.toFixed(4)} (~$${uncachedUsd.toFixed(4)} without caching) · ` +
      `session ~$${sessionCostUsd.toFixed(4)}]`,
  );
}

export const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
