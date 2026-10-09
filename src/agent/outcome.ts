// Outcomes (stage 11): ask for a deliverable with a rubric, and let a grader
// send the agent back until the work meets it.
//
// A user.message starts a conversational turn: the agent answers once, and
// judging whether the answer is good enough is up to you. A
// user.define_outcome starts *work*: a description of the deliverable plus a
// rubric of criteria. After each attempt, a separate grader, with a context of
// its own, checks the work against every criterion. If something falls short,
// it tells the agent what, and the agent revises. That repeats until the
// grader is satisfied or the allowed attempts run out.

import type Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { styleText } from "node:util";

type SessionEvent = Anthropic.Beta.Sessions.BetaManagedAgentsStreamSessionEvents;

const rubric = readFileSync(new URL("../../data/report-rubric.md", import.meta.url), "utf8");

export function reportOutcome(): Anthropic.Beta.Sessions.BetaManagedAgentsUserDefineOutcomeEventParams {
  return {
    type: "user.define_outcome",
    // The task. It takes the place of a user.message: the agent starts on it
    // as soon as the event arrives.
    description:
      "Write today's route problems report for the dispatch team, with a chart of the planned load per van.",
    // The criteria the grader checks one by one. Explicit, checkable criteria
    // make the grading consistent; vague ones make it noisy. A rubric can
    // also be an uploaded file ({ type: "file", file_id }), to reuse it across
    // sessions without sending it each time.
    rubric: { type: "text", content: rubric },
    // How many times the grader may check (default 3, at most 20). Each extra
    // attempt costs another round of agent and grader work.
    max_iterations: 3,
  };
}

// Prints the outcome's own events, and returns whether the event was one.
export function showOutcomeEvent(event: SessionEvent): boolean {
  switch (event.type) {
    case "user.define_outcome":
      // The stream echoes what you sent, now with an outcome_id.
      console.log(
        styleText("cyan", `\noutcome › ${event.description}`) +
          styleText("dim", ` (${event.outcome_id}, up to ${event.max_iterations ?? 3} checks)`),
      );
      return true;
    case "span.outcome_evaluation_start":
      console.log(styleText("cyan", `\ngrader › checking attempt ${event.iteration + 1} against the rubric…`));
      return true;
    case "span.outcome_evaluation_ongoing":
      // A heartbeat while the grader works. Its reasoning isn't shown.
      return true;
    case "span.outcome_evaluation_end": {
      // satisfied: done. needs_revision: the agent revises and tries again.
      // max_iterations_reached, failed or interrupted: the outcome stops.
      const color = event.result === "satisfied" ? "green" : event.result === "needs_revision" ? "yellow" : "red";
      console.log(styleText(color, `grader › ${event.result}`) + `: ${event.explanation}`);
      return true;
    }
  }
  return false;
}
