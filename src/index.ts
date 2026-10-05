// Stage 5: structured output.
//
// Chat answers are prose for a person to read. /audit asks for data a
// program can use instead. You describe the shape with a Zod schema; the SDK
// turns it into a JSON Schema and sends it as output_config.format; and the
// API constrains Claude's output to valid JSON for that schema. parse() then
// checks the JSON against the Zod schema and hands you a typed object, so
// your code can sort, count and color the problems without parsing any text.
//
// Run:  npm start   then type.
//   /audit           lists every problem in the data as structured JSON
//   /effort <level>  low | medium | high | xhigh | max (starts at low)
//   /raw             toggles printing the request JSON and every stream event (on by default)
//   /history         shows a summary of what gets sent
//   exit             quits (or Ctrl+D)

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { readFileSync } from "node:fs";
import * as readline from "node:readline";
import { styleText } from "node:util";

// With no arguments the client reads ANTHROPIC_API_KEY from the environment
// (npm start loads it from .env).
const client = new Anthropic();

// The system prompt sets Claude's role and rules for the whole conversation.
// It's a separate field, not a message, and like the history it's sent with
// every request.
const instructions =
  "You are a route analyst for Rota Express, a delivery company. Dispatchers " +
  "ask you about today's planned routes. The route data below is your source " +
  "of truth: answer from it, refer to routes, vehicles and stops by ID, and " +
  "show the numbers behind each conclusion. If the data doesn't answer a " +
  "question, say so instead of guessing. Answer briefly and concretely.";

const routeData = readFileSync(new URL("../data/routes.json", import.meta.url), "utf8");

// The system prompt can be a plain string or a list of text blocks. Blocks
// let you put a cache marker at a specific point.
const system: Anthropic.Beta.BetaTextBlockParam[] = [
  { type: "text", text: instructions },
  {
    type: "text",
    // XML-style tags tell Claude where the data starts and ends.
    text: `<route_data>\n${routeData}</route_data>`,
    // Breakpoint 1: cache the prompt up to and including this block. The
    // instructions and the dataset never change, so every request reads them
    // from the cache, even when the conversation part misses.
    cache_control: { type: "ephemeral" },
  },
];

// The shape /audit asks for. Each .describe() becomes a "description" in the
// JSON Schema the API receives, so it works as an instruction for that field.
// Enums limit a field to fixed values your code can branch on.
const Problem = z.object({
  kind: z.enum(["capacity", "time_window", "driver_shift", "routing", "unassigned", "other"]),
  severity: z.enum(["high", "medium", "low"]),
  route_id: z.string().nullable().describe("Route ID, or null for an unassigned delivery"),
  stop_ids: z.array(z.string()).describe("Stops involved; empty if the problem is route-wide"),
  summary: z.string().describe("One sentence"),
  evidence: z.string().describe("The numbers from the data that show the problem"),
  suggested_fix: z.string().describe("One concrete change a dispatcher could make"),
});
const AuditReport = z.object({ problems: z.array(Problem) });
type AuditReport = z.infer<typeof AuditReport>; // the TypeScript type, derived from the schema

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];

// The conversation history. It lives in your process; the API never stores it.
const messages: Anthropic.Beta.BetaMessageParam[] = [];
let sessionCostUsd = 0;
let showRaw = true;
let effort: Effort = "low";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let inputClosed = false; // Ctrl+D can close input while a request is in flight
rl.on("close", () => (inputClosed = true));
const { routes, unassigned } = JSON.parse(routeData);
console.log(`Route analyst. Loaded ${routes.length} routes and ${unassigned.length} unassigned deliveries.`);
console.log("Commands: /audit, /effort <level>, /raw, /history, exit.");
rl.setPrompt("\nyou › ");
rl.prompt();

for await (const line of rl) {
  const text = line.trim();
  if (text === "exit") break;
  else if (text === "/history") printHistory();
  else if (text === "/audit") await audit();
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
    // and compare the thinking, output tokens and time. Changing it also
    // invalidates the cached history, so expect a cache write on that turn.
    output_config: { effort },

    // Thinking happens, and is billed, whatever `display` says. "summarized"
    // returns a readable summary of it. The default, "omitted", returns the
    // empty thinking text you saw in stage 2.
    thinking: { type: "adaptive", display: "summarized" },

    system, // instructions + dataset: the same bytes on every request
    messages, // the full history, every time

    // Breakpoint 2, automatic: the API puts a marker on the last block of the
    // request, so it moves forward as the conversation grows. Each turn then
    // also reads the previous turns from the cache and writes only what's new.
    cache_control: { type: "ephemeral" },

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

  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const timing = firstOutputAt
    ? `${seconds(firstOutputAt - startedAt)} to first output, ${seconds(finishedAt - startedAt)} total`
    : `${seconds(finishedAt - startedAt)} total`;
  const cutOff = response.stop_reason === "max_tokens" ? " · CUT OFF (max_tokens)" : "";
  console.log(`\n[turn ${messages.length / 2} · effort ${effort} · ${timing}${cutOff}]`);
  printUsage(response.usage);
}

// /audit is a separate one-question conversation: its answer isn't added to
// the chat history. It sends the same system prompt as the chat, so the
// dataset is still read from the cache.
async function audit() {
  const request = {
    model: "claude-opus-5-5",

    // Not streamed: the JSON is only usable once it's complete. Without
    // streaming, keep max_tokens moderate so the request stays within the
    // SDK's HTTP timeout.
    max_tokens: 16000,

    output_config: {
      effort,
      // The schema the response must follow. With /raw on, look for it in
      // the request: this is the JSON Schema generated from the Zod schema.
      // The SDK's converter keeps only some keywords. Others, like the enums
      // here, become a hint inside "description". So the API guarantees valid
      // JSON with the right fields and types, and parse() enforces the enum
      // values afterwards with Zod.
      format: betaZodOutputFormat(AuditReport),
    },
    thinking: { type: "adaptive", display: "summarized" },
    system,
    messages: [
      {
        role: "user",
        content:
          "Audit today's plan. List every problem you find in the data: vehicle " +
          "capacity, time windows, driver shifts, routing, and unassigned deliveries.",
      },
    ],
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    // `satisfies` checks the shape but keeps the exact type of `format`, which
    // is how parse() knows parsed_output is an AuditReport.
  } satisfies Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

  if (showRaw) {
    const { betas, ...body } = request;
    printRaw(`→ POST /v1/messages   anthropic-beta: ${betas.join(",")}`, body);
  }

  console.log(styleText("dim", `\nauditing at effort ${effort}…`));
  const startedAt = performance.now();
  let response;
  try {
    // parse() is create() plus a final step: it validates the JSON text
    // against the Zod schema and puts the typed result in parsed_output.
    response = await client.beta.messages.parse(request);
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      console.error(`\nAPI error: ${error.message}`);
      return;
    }
    // Not an HTTP error: the JSON didn't validate, for example because the
    // output was cut off or a refusal stopped it partway.
    if (error instanceof Anthropic.AnthropicError) {
      console.error(`\n${error.message}`);
      return;
    }
    throw error;
  }

  if (showRaw) printRaw("← 200 response body", response);

  // Always check stop_reason before using the content.
  if (response.stop_reason === "refusal") {
    console.error("\nDeclined:", response.stop_details);
    return;
  }
  const report = response.parsed_output; // AuditReport | null, fully typed
  if (!report) {
    console.error(`\nNo structured output (stop_reason: ${response.stop_reason}).`);
    return;
  }

  printReport(report);
  console.log(`\n[audit · effort ${effort} · ${((performance.now() - startedAt) / 1000).toFixed(1)}s]`);
  printUsage(response.usage);
}

// Everything here is plain code over typed fields: sorting by severity,
// counting, coloring. None of it would be reliable on free-form text.
function printReport(report: AuditReport) {
  const rank = { high: 0, medium: 1, low: 2 } as const;
  const color = { high: "red", medium: "yellow", low: "dim" } as const;
  const problems = report.problems.toSorted((a, b) => rank[a.severity] - rank[b.severity]);

  for (const p of problems) {
    const where = [p.route_id ?? "unassigned", ...p.stop_ids].join(" ");
    console.log(`\n${styleText(color[p.severity], p.severity.toUpperCase().padEnd(6))} ${p.kind.padEnd(12)} ${where}`);
    console.log(`       ${p.summary}`);
    console.log(styleText("dim", `       evidence: ${p.evidence}`));
    console.log(`       fix: ${p.suggested_fix}`);
  }

  const count = (s: keyof typeof rank) => problems.filter((p) => p.severity === s).length;
  console.log(`\n${problems.length} problems: ${count("high")} high, ${count("medium")} medium, ${count("low")} low`);
}

function printUsage(usage: Anthropic.Beta.BetaUsage) {
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
  // Very long strings, like the dataset, are cut short on screen only. The
  // API always receives them in full.
  const shorten = (_key: string, v: unknown) =>
    typeof v === "string" && v.length > 2000 ? `${v.slice(0, 300)} … [${v.length - 300} more characters not shown]` : v;
  console.log(styleText("cyan", `\n${label}`));
  console.log(styleText("dim", JSON.stringify(value, shorten, 2)));
}

function printHistory() {
  console.log(`\nEvery request sends the system prompt plus these ${messages.length} messages:`);
  messages.forEach((m, i) => {
    const blocks = typeof m.content === "string" ? ["text"] : m.content.map((b) => b.type);
    console.log(`  ${String(i + 1).padStart(2)}. ${m.role.padEnd(9)} ${blocks.join(", ")}`);
  });
}
