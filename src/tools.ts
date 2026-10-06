// Tools (stage 6): functions your code runs when Claude asks for them.
//
// A tool is a name, a description and a JSON Schema for its input. Claude
// never runs anything itself. When it wants a tool, it ends its response
// with stop_reason "tool_use" and one or more tool_use blocks, each with an
// id, the tool name and the input. Your code runs the function and sends the
// output back as a tool_result block with the same id. Then Claude continues,
// and may ask for more tools. That back and forth is the loop in chat.ts.
//
// These two tools do what Claude can't do reliably by reading the data:
// exact arithmetic, and testing a change before recommending it.

import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { routeData, type Stop } from "./data.ts";

// The travel model the dataset's planned times were built with.
const ROAD_FACTOR = 1.35; // roads run about 35% longer than a straight line
const AVG_KMH = 22;

// Tool definitions, sent with every request. The description is what Claude
// reads to decide when to call a tool, so say *when* to use it, not just what
// it does. Tools render first in the prompt (tools → system → messages), so
// they're part of the cached prefix: keep them identical between requests.
export const tools: Anthropic.Beta.BetaTool[] = [
  {
    name: "distance",
    description:
      "Road distance and drive time between two places. Call this whenever an " +
      "answer depends on how far apart two places are or how long the drive " +
      "takes. Don't estimate distances from coordinates yourself.",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "A stop ID such as S101, or DEPOT" },
        to: { type: "string", description: "A stop ID such as S101, or DEPOT" },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
    // Streams the input as Claude writes it instead of buffering it on the
    // server. The server then doesn't validate it, so runTool() does.
    eager_input_streaming: true,
  },
  {
    name: "evaluate_route",
    description:
      "Recalculates a route with the travel model: arrival and wait at each " +
      "stop, late stops, load against capacity, road km, and return time " +
      "against the driver's shift. Call it before stating any total or timing " +
      "for a route. Without stop_order it evaluates the plan as it is. With " +
      "stop_order it simulates a change: reorder stops, move in stops from " +
      "another route, or add unassigned deliveries. Use it to check a fix " +
      "before recommending it. Nothing is saved.",
    input_schema: {
      type: "object",
      properties: {
        route_id: { type: "string", description: "R1 to R4; sets the vehicle, driver and start time" },
        stop_order: {
          type: "array",
          items: { type: "string" },
          description: "Stop IDs in the order to visit them. Omit to use the current plan.",
        },
      },
      required: ["route_id"],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
];

// The same inputs as Zod schemas, for checking what Claude actually sent.
// Writing each schema twice is the price of a hand-built loop; stage 7's
// tool runner derives the JSON Schema from the Zod one.
const DistanceInput = z.object({ from: z.string(), to: z.string() });
const EvaluateRouteInput = z.object({ route_id: z.string(), stop_order: z.array(z.string()).optional() });

// A problem Claude can fix by calling the tool differently.
class ToolError extends Error {}

export function runTool(call: Anthropic.Beta.BetaToolUseBlock): Anthropic.Beta.BetaToolResultBlockParam {
  try {
    const output = execute(call.name, call.input);
    // Content is usually text; JSON is easy for Claude to read and cite.
    return { type: "tool_result", tool_use_id: call.id, content: JSON.stringify(output) };
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    // is_error tells Claude the call failed. A clear message lets it retry
    // with better input or explain the problem.
    return { type: "tool_result", tool_use_id: call.id, content: error.message, is_error: true };
  }
}

function execute(name: string, input: unknown) {
  if (name === "distance") {
    const { from, to } = validate(DistanceInput, input);
    const leg = travel(place(from), place(to));
    return { from, to, road_km: round1(leg.km), drive_min: leg.min };
  }
  if (name === "evaluate_route") {
    const { route_id, stop_order } = validate(EvaluateRouteInput, input);
    return evaluateRoute(route_id, stop_order);
  }
  throw new ToolError(`Unknown tool: ${name}`);
}

function validate<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  // The documented convention for input that doesn't fit the schema: send
  // the raw input back under INVALID_JSON so Claude can see what went wrong.
  if (!parsed.success) throw new ToolError(JSON.stringify({ INVALID_JSON: JSON.stringify(input) }));
  return parsed.data;
}

function evaluateRoute(routeId: string, stopOrder?: string[]) {
  const route = routeData.routes.find((r) => r.id === routeId);
  if (!route) throw new ToolError(`Unknown route ${routeId}. Routes: ${routeData.routes.map((r) => r.id).join(", ")}`);
  const vehicle = routeData.vehicles.find((v) => v.id === route.vehicle_id)!;

  const ids = stopOrder ?? route.stops.map((s) => s.stop_id);
  if (new Set(ids).size !== ids.length) throw new ToolError("stop_order lists a stop more than once");
  const stops = ids.map(findStop);

  let clock = minutes(route.planned_start);
  let position = place("DEPOT");
  let roadKm = 0;
  const timeline = stops.map((stop) => {
    const leg = travel(position, place(stop.stop_id));
    clock += leg.min;
    roadKm += leg.km;
    const arrival = clock;
    const [open, close] = stop.window.split("-").map(minutes);
    clock = Math.max(clock, open); // wait for the window to open
    clock += stop.service_min;
    position = place(stop.stop_id);
    return {
      stop_id: stop.stop_id,
      arrival: hhmm(arrival),
      window: stop.window,
      wait_min: Math.max(0, open - arrival),
      late_min: Math.max(0, arrival - close),
    };
  });
  const back = travel(position, place("DEPOT"));
  clock += back.min;
  roadKm += back.km;

  const loadKg = stops.reduce((sum, s) => sum + s.weight_kg, 0);
  const shiftEnd = minutes(vehicle.shift.split("-")[1]);
  return {
    route_id: route.id,
    vehicle_id: vehicle.id,
    driver: vehicle.driver,
    simulated: stopOrder !== undefined,
    stops: timeline,
    late_stops: timeline.filter((t) => t.late_min > 0).map((t) => t.stop_id),
    load_kg: loadKg,
    capacity_kg: vehicle.capacity_kg,
    over_capacity_kg: Math.max(0, loadKg - vehicle.capacity_kg),
    road_km: round1(roadKm),
    start: route.planned_start,
    return: hhmm(clock),
    shift_end: hhmm(shiftEnd),
    overtime_min: Math.max(0, clock - shiftEnd),
    left_out: route.stops.map((s) => s.stop_id).filter((id) => !ids.includes(id)),
  };
}

function findStop(id: string): Stop {
  const stop = [...routeData.routes.flatMap((r) => r.stops), ...routeData.unassigned].find((s) => s.stop_id === id);
  if (!stop) throw new ToolError(`Unknown stop ${id}`);
  return stop;
}

function place(id: string): { lat: number; lng: number } {
  if (id.toUpperCase() === "DEPOT") return routeData.depot;
  const stop = findStop(id);
  if (stop.lat === null || stop.lng === null) throw new ToolError(`Stop ${id} has no coordinates: ${stop.reason ?? "unknown location"}`);
  return { lat: stop.lat, lng: stop.lng };
}

// Straight-line (haversine) distance, stretched by the road factor.
function travel(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  const km = 2 * 6371 * Math.asin(Math.sqrt(h)) * ROAD_FACTOR;
  return { km, min: Math.round((km / AVG_KMH) * 60) };
}

const minutes = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const round1 = (n: number) => Math.round(n * 10) / 10;
