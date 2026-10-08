// Files in and files out of a session (stage 10).
//
// In: a file uploaded with the Files API can be attached to a session as a
// resource. It's mounted read-only into the container when the session
// starts, under /mnt/session/uploads/. (The session works on its own copy,
// with a different file id, so the upload stays reusable.)
//
// Out: anything the agent writes to /mnt/session/outputs/ is captured by the
// Files API, tagged with the session's id. Listing files filtered by that id
// finds them, and downloading saves them locally.

import Anthropic from "@anthropic-ai/sdk";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { styleText } from "node:util";
import { client } from "../client.ts";
import { uploadRouteData } from "../server-tools.ts";
import { DATA_MOUNT } from "./config.ts";

// The session resource for the dataset. It reuses the upload from stage 8,
// which uploads routes.json once and finds it again on later runs.
export async function routeDataResource(): Promise<Anthropic.Beta.Sessions.BetaManagedAgentsFileResourceParams> {
  return { type: "file", file_id: await uploadRouteData(), mount_path: DATA_MOUNT };
}

// Files already downloaded, or skipped because they can't be downloaded.
const seen = new Set<string>();

// Downloads the session's output files that haven't been downloaded yet, into
// outputs/<session id>/, and returns how many it saved. Files take a second or
// two to show up after the turn that wrote them, so when the turn wrote there,
// keep checking for a while.
export async function saveSessionOutputs(sessionId: string, expectNewFiles: boolean): Promise<number> {
  const attempts = expectNewFiles ? 5 : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, 1500));

    const fresh: Anthropic.Beta.BetaFileMetadata[] = [];
    // Filtering by scope_id needs the managed-agents beta header, which this
    // call doesn't add on its own.
    for await (const file of client.beta.files.list({ scope_id: sessionId, betas: ["managed-agents-2026-04-01"] })) {
      if (seen.has(file.id)) continue;
      // The list can also hold files the session didn't generate, like its
      // copy of the mounted dataset. Only files a tool generated can be
      // downloaded, and the downloadable flag says which ones those are.
      if (file.downloadable === false) {
        seen.add(file.id);
        continue;
      }
      fresh.push(file);
    }
    if (fresh.length === 0) continue;

    // Oldest first: if the agent rewrote a file, the newest version is saved last.
    fresh.sort((a, b) => a.created_at.localeCompare(b.created_at));
    const dir = fileURLToPath(new URL(`../../outputs/${sessionId}/`, import.meta.url));
    await mkdir(dir, { recursive: true });
    let saved = 0;
    for (const file of fresh) {
      // The name comes from the agent. Keep only the base name, so it can't
      // point outside the folder.
      const name = path.basename(file.filename);
      if (!name || name === "." || name === "..") continue;
      try {
        const content = await client.files.download(file.id);
        const target = path.join(dir, name);
        await writeFile(target, Buffer.from(await content.arrayBuffer()));
        seen.add(file.id);
        saved++;
        console.log(styleText("green", `saved ${path.relative(process.cwd(), target)}`));
      } catch (error) {
        // One failed download shouldn't stop the others. It's tried again
        // after the next turn.
        if (!(error instanceof Anthropic.APIError)) throw error;
        console.error(styleText("yellow", `couldn't download ${name}: ${error.message}`));
      }
    }
    return saved;
  }
  if (expectNewFiles) console.log(styleText("yellow", "The agent wrote to the outputs folder, but no new files showed up yet."));
  return 0;
}
