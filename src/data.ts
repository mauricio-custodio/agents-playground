// Today's plan for the fictional Rota Express. The JSON text goes into the
// system prompt as-is; the parsed object is for code that needs the values.

import { readFileSync } from "node:fs";

export const routeDataText = readFileSync(new URL("../data/routes.json", import.meta.url), "utf8");

export const routeData: { routes: unknown[]; unassigned: unknown[] } = JSON.parse(routeDataText);
