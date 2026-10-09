# agents-playground

Learning the Claude API hands-on by building one project end to end: a **route analyst**, an assistant that answers questions about delivery-route data. It starts as a single API call and ends as a hosted Managed Agent.

## Setup

```bash
npm install
cp .env.example .env   # then paste your API key into .env
npm start              # then type a question
```

## Commands

| Command | What it does |
|---|---|
| any text | Asks the route analyst a question |
| `/audit` | Lists every problem in the data as structured JSON (stage 5) |
| `/effort <level>` | Sets effort: `low` (the default), `medium`, `high`, `xhigh`, `max` |
| `/raw` | Shows or hides the exact request JSON and every stream event (off by default) |
| `/history` | Lists the messages that get sent with every request |
| `exit` | Quits (or Ctrl+D) |

After every answer, a status line shows the requests made, the timing, the prompt split into cache read, cache write and uncached tokens, and the estimated cost.

### The managed agent (Part 3)

The same analyst as a Managed Agent has its own entry point:

```bash
npm run agent:setup   # once: creates the environment and the agent, saves their ids to managed-agent.json
npm run agent         # starts a session and chats with it
npm run agent:outputs sesn_…   # downloads a session's output files again (stage 10)
```

Run `npm run agent:setup` again after changing the agent's definition in `src/agent/config.ts`: it updates the agent to a new version instead of creating another one. In the chat, `/report` asks for the problems report as an outcome checked against `data/report-rubric.md` (stage 11), `/raw` prints every event as JSON, and `exit` quits and archives the session. Each session has a $5 spending cap.

## Code layout

| File | What it covers |
|---|---|
| `src/index.ts` | The REPL: reads commands and calls the modules below |
| `src/client.ts` | The Anthropic client, the model, refusal fallbacks |
| `src/chat.ts` | Chat turns: history, streaming, thinking, the tool runner |
| `src/tools.ts` | Tools Claude can call (`distance`, `evaluate_route`), defined with `betaZodTool` |
| `src/server-tools.ts` | Server tools (code execution, web search), the Files API upload, and saving charts to `outputs/` |
| `src/prompt.ts` | System prompt, grounding, prompt caching |
| `src/data.ts` | Loads `data/routes.json` |
| `src/audit.ts` | `/audit`: structured output with Zod |
| `src/settings.ts` | Effort and raw view, changed by commands |
| `src/output.ts` | Printing raw JSON, usage and cost |
| `src/agent/index.ts` | The managed agent's chat: one session per run |
| `src/agent/config.ts` | The agent and environment definitions, and the saved ids |
| `src/agent/setup.ts` | Creates the environment and agent, or updates the agent to a new version |
| `src/agent/session.ts` | One turn: send a message, follow the session's events, run custom tools |
| `src/agent/files.ts` | Mounts the dataset into the session, downloads reports and charts to `outputs/<session id>/` |
| `src/agent/outputs.ts` | `npm run agent:outputs <session id>`: downloads any session's output files, even after it's archived |
| `src/agent/outcome.ts` | `/report`: the problems report as an outcome, and the grader's events |
| `data/report-rubric.md` | The rubric the grader checks the report against (a starter: tune it) |

## Roadmap

Each stage builds on the one before it. The point is to see what each layer adds and what it costs you to own.

### Part 1: Messages API basics

- [x] **1. First call**: request shape, content blocks, `stop_reason`, token usage and cost
- [x] **2. Chat loop**: multi-turn REPL with a system prompt. The API is stateless, so you keep the history.
- [x] **3. Streaming + thinking**: stream tokens as they arrive, show thinking summaries, tune effort
- [x] **4. Grounding + caching**: put a route dataset in the prompt, use prompt caching, watch `cache_read_input_tokens`
- [x] **5. Structured output**: get typed JSON back, validated against a Zod schema

### Part 2: You run the agent loop

- [x] **6. Tools, manual loop**: give Claude `distance` and `evaluate_route` tools for exact numbers and what-if checks, and drive the `tool_use` → `tool_result` loop yourself
- [x] **7. Tool runner**: replace that loop with the SDK's tool runner
- [x] **8. Server tools**: let Claude run code and search the web on Anthropic's side

### Part 3: Anthropic runs the agent loop (Managed Agents)

- [x] **9. First managed agent**: create the agent and environment once, start a session per run, stream events
- [x] **10. Files in, files out**: upload the dataset, have the agent analyze it in its sandbox and return a report or chart
- [x] **11. Outcomes**: give the agent a rubric and let a grader send its work back until it passes
- [ ] **12. Going further**: memory across sessions, a scheduled nightly report, multiple agents

## Trying each stage

Stages 2 to 11 all work on `main`. Stage 1, and experiments marked "on `stage-N`", need that stage's git tag:

```bash
git checkout stage-1      # go back with: git checkout main
git diff stage-3 stage-4  # see what a stage added
```

For stage 6, diff from the refactor commit instead: `git diff 26d4d1d stage-6`.

Questions cost a few cents each at `/effort low`. The status line shows the exact amount.

### The answer key

The dataset has five planted problems. Check Claude's answers against them:

| Route | Problem |
|---|---|
| R1 | Ana's shift ends at 13:30, but the planned return is 14:03 (33 minutes over) |
| R2 | VAN-02 carries 815 kg, over its 800 kg capacity |
| R3 | S302 is planned for 09:12, but its window closes at 09:00. Visiting S302 before S301 fixes it |
| R4 | S404 is in Moema, across the city from the rest of the northern route. R4 drives about 83.5 km; without S404, about 56.6 km |
| Unassigned | S501 (no van with room), S502 (address couldn't be geocoded), S503 (window ends before any route can reach it) |

### Stage 1: first call (on `stage-1`)

- Run `npm start -- "What makes a delivery route efficient?"`.
- Set `effort` in `src/index.ts` to `"low"`, then `"high"`, and compare `tokens` and `cost`.

**Look for:** `blocks: thinking, text`. The thinking block is there even when empty, and it's billed as output tokens.

### Stage 2: chat loop

- Ask a question, then a follow-up like "What if one van breaks down?".
- `/history` lists what gets resent. `/raw` shows the `messages` array growing each turn.
- Change the instructions in `src/prompt.ts` (say, "Always answer in Portuguese") and restart.
- On `stage-2`: comment out `messages.push({ role: "assistant", ... })` in `src/index.ts`. Claude forgets its own answers.

**Look for:** input tokens grow every turn, because the whole history is resent.

### Stage 3: streaming and thinking

- Ask the same planning question at `/effort low` and `/effort high`. Compare thinking, output tokens and time.
- Ask for something long ("Write a checklist for onboarding a new driver"). Compare "to first output" with "total".
- In `/raw`, find `signature_delta` (ends a thinking block) and `message_delta` (`stop_reason` and final usage).

**Look for:** the total time barely changes, but text appears much sooner.

### Stage 4: grounding and caching

- Ask two questions in a row. The first writes the cache, the second reads it.
- Restart and ask again within 5 minutes. The cache lives on Anthropic's side, so it still hits.
- Change `/effort`, or wait more than 5 minutes, and the cache is written again.

**Look for:** the "without caching" cost next to the real one in the status line.

### Stage 5: structured output

- Run `/audit` at `/effort low` and `/effort high`. Compare with the answer key.
- In `/raw`, read `output_config.format`: the JSON Schema built from Zod. Enums are only hints there; the Zod check enforces them.
- Add a field in `src/audit.ts` (say, `estimated_minutes_lost: z.number()`) and run `/audit` again.

**Look for:** `/audit` sends no tools, so it writes a cache entry of its own.

### Stages 6 and 7: tools

- "How many km does R4 drive, and why so far?" Claude calls `evaluate_route` and `distance` and points to S404.
- "Fix R3's late stop." Claude tries stop orders until S302 comes before S301.
- "Can S501 fit on any route?" Several simulations, maybe in parallel.
- `/history` shows the `tool_use` and `tool_result` messages; `/raw` shows the JSON.

**Look for:** each round of tool calls is one more request in the status line. Stage 7 behaves the same; compare the code with `git diff stage-6 stage-7 -- src/chat.ts src/tools.ts`.

### Stage 8: server tools

- "Chart each van's load against its capacity." Python runs on Anthropic's side and the PNG is saved to `outputs/`.
- "Is anything happening in São Paulo today that could slow deliveries?" Web search, $0.01 per search. The dataset's date is 2026-10-06.
- "Using Python, find the two stops furthest apart." Then ask a follow-up that reuses its files.
- `/history` shows the `container_upload`, `server_tool_use` and result blocks.

**Look for:** no `tool_use` stop. The call and its result come back in the same response, and the container keeps its files between turns.

### Stage 9: first managed agent

- Run `npm run agent:setup`. Run it again: the agent is up to date. Edit `src/agent/config.ts` and rerun: it moves to version 2.
- Run `npm run agent`, open the Console link, ask "Why is R3 late?" and follow it in both places.
- Ask "How many km does R4 drive?". `custom tool ›` runs in your program; `tool ›` runs on Anthropic's side.
- `/raw` shows each event, from `session.status_running` to `end_turn`.

**Look for:** nothing is resent between turns, because the session keeps the conversation. The status line shows the session's cost so far (capped at $5). `exit` archives the session.

### Stage 10: files in, files out

- Run `npm run agent:setup` first, to update the environment and the agent.
- Ask "Write a report of today's problems, with a chart of the load per van." The files download to `outputs/<session id>/`.
- Follow up with "Add the R4 detour to the report." The agent edits the same file.
- Ask "Which van is overloaded?" and watch the agent read the file first.
- After `exit`, run `npm run agent:outputs <session id>`. The files outlive the session.

**Look for:** an extra file-reading step, in exchange for paying only for the data the agent actually reads.

### Stage 11: outcomes

- Run `npm run agent`, then `/report`. It sends the task and the rubric in `data/report-rubric.md` as an outcome, with up to 3 checks.
- Watch the `grader ›` lines. On `needs_revision`, the agent revises without you sending anything.
- Make the rubric stricter (say, "Each fix was checked with evaluate_route") and run `/report` in a new session.
- Compare the report with the answer key. The rubric never names the planted problems.

**Look for:** the session stays `running` until the outcome ends (`satisfied`, `max_iterations_reached`, `failed` or `interrupted`). Grader tokens are billed and counted separately.
