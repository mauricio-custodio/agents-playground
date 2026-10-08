// npm run agent:outputs <session id>: downloads a session's output files.
//
// Output files outlive the chat. They stay in the Files API, tagged with the
// session's id, even after the session is archived, so they can be fetched
// again later: for example when a chat ended before its files were saved.
// It works on a session that's still running, too.

import Anthropic from "@anthropic-ai/sdk";
import { saveSessionOutputs } from "./files.ts";

const sessionId = process.argv[2];
if (!sessionId?.startsWith("sesn_")) {
  console.error("Usage: npm run agent:outputs <session id>  (the id starts with sesn_)");
  process.exit(1);
}

try {
  const saved = await saveSessionOutputs(sessionId, false);
  if (saved === 0) console.log(`No downloadable files for session ${sessionId}.`);
} catch (error) {
  if (!(error instanceof Anthropic.APIError)) throw error;
  console.error(`API error: ${error.message}`);
  process.exitCode = 1;
}
