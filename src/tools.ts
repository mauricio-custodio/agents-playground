// Tools: functions your code runs when Claude asks for them (stage 6),
// defined for the SDK's tool runner (stage 7).
//
// A tool is a name, a description and a JSON Schema for its input. Claude
// never runs anything itself. When it wants a tool, it ends its response
// with stop_reason "tool_use" and one or more tool_use blocks, each with an
// id, the tool name and the input. The function runs on your side and its
// output goes back as a tool_result block with the same id.
//
// betaZodTool keeps everything about a tool in one place: the definition sent
// to the API (its JSON Schema is generated from the Zod schema), the check of
// the input Claude sends, and the function that runs. In stage 6 these were
// three separate pieces: a hand-written JSON Schema, a Zod schema, and a
// switch on the tool name.
//
// These two tools do what Claude can't do reliably by reading the data:
// exact arithmetic, and testing a change before recommending it.

import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { routeData, type Stop } from "./data.ts";

// The travel model the dataset's planned times were built with.
const ROAD_FACTOR = 1.35; // roads run about 35% longer than a straight line
const AVG_KMH = 22;

// The description is what Claude reads to decide when to call a tool, so say
// *when* to use it, not just what it does. Tools render first in the prompt
// (tools → system → messages), so they're part of the cached prefix: keep
// them identical between requests.
const distance = betaZodTool({
  name: "distance",
  description:
    "Road distance and drive time between two places. Call this whenever an " +
    "answer depends on how far apart two places are or how long the drive " +
    "takes. Don't estimate distances from coordinates yourself.",
  inputSchema: z.object({
    from: z.string().describe("A stop ID such as S101, or DEPOT"),
    to: z.string().describe("A stop ID such as S101, or DEPOT"),
  }),
  // run() only gets input that passed the Zod check, already typed. What it
  // returns becomes the tool_result content. If it throws, the runner sends
  // the error message back as an is_error result instead of crashing.
  run: async ({ from, to }) => {
    const leg = travel(place(from), place(to));
    return JSON.stringify({ from, to, road_km: round1(leg.km), drive_min: leg.min });
  },
});

const evaluateRoute = betaZodTool({
  name: "evaluate_route",
  description:
    "Recalculates a route with the travel model: arrival and wait at each " +
    "stop, late stops, load against capacity, road km, and return time " +
    "against the driver's shift. Call it before stating any total or timing " +
    "for a route. Without stop_order it evaluates the plan as it is. With " +
    "stop_order it simulates a change: reorder stops, move in stops from " +
    "another route, or add unassigned deliveries. Use it to check a fix " +
    "before recommending it. Nothing is saved.",
  inputSchema: z.object({
    route_id: z.string().describe("R1 to R4; sets the vehicle, driver and start time"),
    stop_order: z
      .array(z.string())
      .describe("Stop IDs in the order to visit them. Omit to use the current plan.")
      .optional(),
  }),
  run: async ({ route_id, stop_order }) => JSON.stringify(evaluate(route_id, stop_order)),
});

// eager_input_streaming isn't an option of betaZodTool, so it's added to the
// finished definitions. It streams each input as Claude writes it; the server
// then skips its own check of the input, and the Zod check above covers it.
export const tools = [distance, evaluateRoute].map((tool) => ({ ...tool, eager_input_streaming: true }));

function evaluate(routeId: string, stopOrder?: string[]) {
  const route = routeData.routes.find((r) => r.id === routeId);
  if (!route) throw new Error(`Unknown route ${routeId}. Routes: ${routeData.routes.map((r) => r.id).join(", ")}`);
  const vehicle = routeData.vehicles.find((v) => v.id === route.vehicle_id)!;

  const ids = stopOrder ?? route.stops.map((s) => s.stop_id);
  if (new Set(ids).size !== ids.length) throw new Error("stop_order lists a stop more than once");
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
  if (!stop) throw new Error(`Unknown stop ${id}`);
  return stop;
}

function place(id: string): { lat: number; lng: number } {
  if (id.toUpperCase() === "DEPOT") return routeData.depot;
  const stop = findStop(id);
  if (stop.lat === null || stop.lng === null) throw new Error(`Stop ${id} has no coordinates: ${stop.reason ?? "unknown location"}`);
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
