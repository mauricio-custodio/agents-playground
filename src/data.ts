// Today's plan for the fictional Rota Express. The JSON text goes into the
// system prompt as-is; the parsed object is for code that needs the values.

import { readFileSync } from "node:fs";

export interface Stop {
  stop_id: string;
  customer: string;
  address: string;
  lat: number | null; // null when the address couldn't be geocoded
  lng: number | null;
  window: string; // "08:00-10:00"
  service_min: number;
  packages: number;
  weight_kg: number;
  planned_arrival?: string; // assigned stops only
  notes?: string;
  reason?: string; // unassigned deliveries only: why it wasn't planned
}

export interface Route {
  id: string;
  vehicle_id: string;
  planned_start: string;
  planned_return: string;
  stops: Stop[];
}

export interface Vehicle {
  id: string;
  capacity_kg: number;
  driver: string;
  shift: string; // "07:00-16:00"
}

export interface RouteData {
  depot: { name: string; lat: number; lng: number };
  vehicles: Vehicle[];
  routes: Route[];
  unassigned: Stop[];
}

export const routeDataText = readFileSync(new URL("../data/routes.json", import.meta.url), "utf8");

export const routeData: RouteData = JSON.parse(routeDataText);
