// The system prompt: instructions plus the dataset, with a cache breakpoint.
//
// Grounding: Claude answers from the dataset, data/routes.json (about 5,500
// tokens), instead of from general knowledge.
//
// Caching: the system prompt is resent with every request. Prompt caching
// lets the API reuse the work it already did on an identical start of a
// prompt. The first request writes the cache (1.25x the normal input price);
// requests in the next 5 minutes read it at 0.05x, and every read restarts
// the 5 minutes.
//
// The prefix rule: the cache matches the prompt byte for byte from the start,
// in the order tools → system → messages. The first difference ends the
// match, and everything from there on is processed at full price again.

import type Anthropic from "@anthropic-ai/sdk";
import { routeDataText } from "./data.ts";

// The system prompt sets Claude's role and rules for the whole conversation.
// It's a separate field, not a message, and like the history it's sent with
// every request.
const instructions =
  "You are a route analyst for Rota Express, a delivery company. Dispatchers " +
  "ask you about today's planned routes. The route data below is your source " +
  "of truth: answer from it, refer to routes, vehicles and stops by ID, and " +
  "show the numbers behind each conclusion. Use the tools for distances, " +
  "timings and totals, and to check a fix before recommending it, instead of " +
  "calculating them yourself. The same data is a JSON file in your code " +
  "execution sandbox: use Python there for charts (save them as PNG files) " +
  "and for analysis across many stops. Use web search only for real-world " +
  "conditions in São Paulo on the service date, such as traffic, weather or " +
  "events. If the data doesn't answer a question, say so instead of " +
  "guessing. Answer briefly and concretely.";

// The system prompt can be a plain string or a list of text blocks. Blocks
// let you put a cache marker at a specific point.
export const system: Anthropic.Beta.BetaTextBlockParam[] = [
  { type: "text", text: instructions },
  {
    type: "text",
    // XML-style tags tell Claude where the data starts and ends.
    text: `<route_data>\n${routeDataText}</route_data>`,
    // Breakpoint 1: cache the prompt up to and including this block. The
    // instructions and the dataset never change, so every request reads them
    // from the cache, even when the conversation part misses.
    cache_control: { type: "ephemeral" },
  },
];
