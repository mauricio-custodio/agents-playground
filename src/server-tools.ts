// Server tools (stage 8): tools that run on Anthropic's side.
//
// Your own tools (tools.ts) run in your process: Claude asks, your code runs
// the function and sends the result back. Server tools are declared in the
// same `tools` list, but the API runs them itself, inside the same request:
// the response already holds both the call (a server_tool_use block) and its
// result (a ..._tool_result block). There's no "tool_use" stop and nothing
// for your code to run.
//
// - Code execution: a sandboxed container with Python and common data
//   libraries, but no internet. Claude writes and runs code there. Files it
//   creates, like charts, can be downloaded with the Files API.
// - Web search: Claude searches the web and gets back titles, URLs and page
//   content it can cite.
//
// Server tools run a loop of their own on Anthropic's side. If it runs long,
// the response stops with stop_reason "pause_turn", and sending the
// conversation back as it is continues it. The tool runner does that for you.

import type Anthropic from "@anthropic-ai/sdk";
import { toFile } from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { client } from "./client.ts";
import { routeDataText } from "./data.ts";

const OUTPUT_DIR = fileURLToPath(new URL("../outputs/", import.meta.url));

export const serverTools: Anthropic.Beta.BetaToolUnion[] = [
  // Anthropic-defined tools need no description or schema: the type names
  // a tool Claude already knows how to use.
  { type: "code_execution_20260521", name: "code_execution" },
  {
    // The basic web search. The newer web_search_20260209 filters results by
    // running code in a sandbox of its own, and a second sandbox next to code
    // execution confuses the model.
    type: "web_search_20250305",
    name: "web_search",
    max_uses: 3, // searches per request; each one costs $0.01
    user_location: { type: "approximate", city: "São Paulo", country: "BR", timezone: "America/Sao_Paulo" },
  },
];

// Code runs in a container that keeps its files between requests. The
// response names it (message.container), and later requests pass that id to
// keep working in the same container, because the history refers to files
// there. The tool runner carries the id within a turn; between turns it's
// kept here.
export const container = { id: undefined as string | undefined };

export function rememberContainer(message: Anthropic.Beta.BetaMessage) {
  if (message.container) container.id = message.container.id;
}

// The Files API stores a file in your workspace. A container_upload block in
// a message then copies it into the container, where code can open it.
// Uploads stay until you delete them, so the file name carries a hash of the
// content: the same data is uploaded once and reused on later runs.
export async function uploadRouteData(): Promise<string> {
  const name = `routes-${createHash("sha256").update(routeDataText).digest("hex").slice(0, 8)}.json`;
  for await (const file of client.files.list()) {
    if (file.filename === name) return file.id;
  }
  const file = await client.files.upload({
    file: await toFile(Buffer.from(routeDataText), name, { type: "application/json" }),
  });
  return file.id;
}

// Files that code creates come back as file ids inside the code execution
// results. Download them into outputs/ and return the saved paths.
export async function saveOutputFiles(message: Anthropic.Beta.BetaMessage): Promise<string[]> {
  const saved: string[] = [];
  for (const block of message.content) {
    if (block.type !== "bash_code_execution_tool_result" || block.content.type !== "bash_code_execution_result") continue;
    for (const output of block.content.content) {
      const metadata = await client.files.retrieveMetadata(output.file_id);
      // The name comes from code Claude wrote. Keep only the base name, so it
      // can't point outside outputs/.
      const name = path.basename(metadata.filename);
      if (!name || name === "." || name === "..") continue;
      const download = await client.files.download(output.file_id);
      await mkdir(OUTPUT_DIR, { recursive: true });
      const target = path.join(OUTPUT_DIR, name);
      await writeFile(target, Buffer.from(await download.arrayBuffer()));
      saved.push(path.relative(process.cwd(), target));
    }
  }
  return saved;
}
