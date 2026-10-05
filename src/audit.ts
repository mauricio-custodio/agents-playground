// /audit: structured output (stage 5).
//
// Chat answers are prose for a person to read. /audit asks for data a
// program can use instead. You describe the shape with a Zod schema; the SDK
// turns it into a JSON Schema and sends it as output_config.format; and the
// API constrains Claude's output to valid JSON for that schema. parse() then
// checks the JSON against the Zod schema and hands you a typed object, so
// your code can sort, count and color the problems without parsing any text.

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { styleText } from "node:util";
import { z } from "zod";
import { client, fallbackParams, MODEL } from "./client.ts";
import { printRaw, printRequest, printUsage, seconds } from "./output.ts";
import { system } from "./prompt.ts";
import { settings } from "./settings.ts";

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

// /audit is a separate one-question conversation: its answer isn't added to
// the chat history. It sends the same system prompt as the chat, so the
// dataset is still read from the cache.
export async function audit() {
  const request = {
    model: MODEL,

    // Not streamed: the JSON is only usable once it's complete. Without
    // streaming, keep max_tokens moderate so the request stays within the
    // SDK's HTTP timeout.
    max_tokens: 16000,

    output_config: {
      effort: settings.effort,
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
    ...fallbackParams,
    // `satisfies` checks the shape but keeps the exact type of `format`, which
    // is how parse() knows parsed_output is an AuditReport.
  } satisfies Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

  if (settings.showRaw) printRequest(request);

  console.log(styleText("dim", `\nauditing at effort ${settings.effort}…`));
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

  if (settings.showRaw) printRaw("← 200 response body", response);

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
  console.log(`\n[audit · effort ${settings.effort} · ${seconds(performance.now() - startedAt)}]`);
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
