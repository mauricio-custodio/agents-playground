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

export function printToolResults(
  calls: { id: string; name: string }[],
  results: Anthropic.Beta.BetaToolResultBlockParam[],
) {
  for (const result of results) {
    const name = calls.find((call) => call.id === result.tool_use_id)?.name ?? "tool";
    const text = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
    const oneLine = text.replace(/\s+/g, " ");
    const shown = oneLine.length > 300 ? `${oneLine.slice(0, 300)}…` : oneLine;
    console.log(styleText(result.is_error ? "red" : "dim", `  ↳ ${name}: ${shown}`));
  }
}

// Server tool calls and their results (stage 8), printed once each block is
// complete. Server tool errors don't throw: they arrive as result blocks with
// an error_code, so each result is checked for one.
export function printServerToolBlock(block: Anthropic.Beta.BetaContentBlock) {
  const dim = (text: string) => console.log(styleText("dim", text));
  const red = (text: string) => console.log(styleText("red", text));

  if (block.type === "server_tool_use") {
    const input = block.input;
    const detail =
      block.name === "web_search" ? `"${input.query}"`
      : block.name === "bash_code_execution" ? String(input.command)
      : block.name === "text_editor_code_execution" ? `${input.command} ${input.path}`
      : JSON.stringify(input);
    console.log(styleText("magenta", `\n\nserver › ${block.name}`));
    dim(indent(clip(detail, 20)));
  } else if (block.type === "bash_code_execution_tool_result") {
    const result = block.content;
    if (result.type === "bash_code_execution_tool_result_error") return red(`  ↳ error: ${result.error_code}`);
    const files = result.content.length > 0 ? ` · ${result.content.length} file(s) created` : "";
    dim(`  ↳ exit code ${result.return_code}${files}`);
    if (result.stdout) dim(indent(clip(result.stdout, 12)));
    if (result.stderr) red(indent(clip(result.stderr, 8)));
  } else if (block.type === "text_editor_code_execution_tool_result") {
    dim(`  ↳ ${block.content.type.replace("text_editor_code_execution_", "")}`);
  } else if (block.type === "web_search_tool_result") {
    // A list of results on success, a single error object on failure.
    if (!Array.isArray(block.content)) return red(`  ↳ error: ${block.content.error_code}`);
    dim(`  ↳ ${block.content.length} results`);
    for (const result of block.content.slice(0, 5)) dim(`    ${result.title} · ${result.url}`);
  }
}

const indent = (text: string) => text.replace(/^/gm, "    ");
const clip = (text: string, maxLines: number) => {
  const lines = text.trimEnd().split("\n");
  return lines.length > maxLines ? [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more lines`].join("\n") : lines.join("\n");
};

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
  // cache read $0.20, output $20. Server tools are billed on top: web search
  // at $10 per 1,000 searches. (Code execution is billed by container time,
  // with free hours each month, so it's left out here.)
  const searches = usage.server_tool_use?.web_search_requests ?? 0;
  const searchUsd = searches * 0.01;
  const costUsd = (input_tokens * 4 + cacheWrite * 5 + cacheRead * 0.2 + output_tokens * 20) / 1_000_000 + searchUsd;
  const uncachedUsd = (promptTokens * 4 + output_tokens * 20) / 1_000_000 + searchUsd;
  sessionCostUsd += costUsd;

  console.log(
    `[prompt ${promptTokens} = ${cacheRead} cache read + ${cacheWrite} cache write + ${input_tokens} uncached · ` +
      `${output_tokens} out${searches ? ` · ${searches} web search${searches === 1 ? "" : "es"}` : ""} · ` +
      `~$${costUsd.toFixed(4)} (~$${uncachedUsd.toFixed(4)} without caching) · session ~$${sessionCostUsd.toFixed(4)}]`,
  );
}

export const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
