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

Every feature stays in the app, so stages 2 to 8 can be tried on `main`. Stage 1, and a couple of experiments marked below, need the code as it was at that stage. Each stage is a git tag:

```bash
git checkout stage-1
```

```bash
git checkout main
```

To see exactly what a stage added, diff it against the one before:

```bash
git diff stage-3 stage-4
```

Between stage 5 and stage 6 there's a refactor commit (`26d4d1d`) that split the code into modules, so `git diff 26d4d1d stage-6` shows only what stage 6 added.

Questions cost a few cents each at `/effort low`. The status line after each answer shows the exact amount.

### The answer key

The dataset has five problems built in. Use them to check whether Claude finds them:

| Route | Problem |
|---|---|
| R1 | Ana's shift ends at 13:30, but the planned return is 14:03 (33 minutes over) |
| R2 | VAN-02 carries 815 kg, over its 800 kg capacity |
| R3 | S302 is planned for 09:12, but its window closes at 09:00. Visiting S302 before S301 fixes it |
| R4 | S404 is in Moema, across the city from the rest of the northern route. R4 drives about 83.5 km; without S404, about 56.6 km |
| Unassigned | S501 (no van with room), S502 (address couldn't be geocoded), S503 (window ends before any route can reach it) |

### Stage 1: first call

Needs `git checkout stage-1`.

- Run `npm start -- "What makes a delivery route efficient?"`.
- Change `effort` in `src/index.ts` to `"low"`, then `"high"`, and compare `tokens` and `cost`.

**Look for:** `blocks: thinking, text`. There's a thinking block even though its text is empty: Opus 5.5 always reasons before answering, and the reasoning is billed as output tokens.

### Stage 2: chat loop

- Ask a question, then a follow-up that only makes sense in context, like "What if one van breaks down?".
- Type `/history` after a couple of turns.
- Turn on `/raw` and watch the `messages` array in the request grow by your question and Claude's full reply on each turn.
- Change the instructions in `src/prompt.ts`, for example to "Always answer in Portuguese", and restart. The system prompt applies to every turn.
- On `stage-2`: comment out the `messages.push({ role: "assistant", ... })` line in `src/index.ts`. Claude then sees your questions but none of its own answers.

**Look for:** input tokens grow every turn, even for short questions, because the whole history is resent. In `/raw`, the thinking block has empty text but a long `signature`: Claude's reasoning in encrypted form, which is why the block has to go back unchanged.

### Stage 3: streaming and thinking

- Ask the same planning question at `/effort low`, then at `/effort high`. Compare the thinking summary, output tokens and total time.
- Ask for something long, like "Write a checklist for onboarding a new driver", and compare "to first output" with "total" in the status line.
- With `/raw` on, find the `signature_delta` that closes each thinking block, and the `message_delta` that carries `stop_reason` and the final usage.

**Look for:** the total time is about the same as without streaming, but you start reading much sooner.

### Stage 4: grounding and caching

- Ask two questions in a row. The first writes the instructions, tools and dataset to the cache (several thousand tokens of cache write); the second reads them back (cache read), with only a few uncached tokens.
- Type `exit`, run `npm start` again, and ask something within 5 minutes. The first turn now reads from the cache: it's stored on Anthropic's side, not in your program.
- Change `/effort` mid-conversation, or wait more than 5 minutes between questions, and watch the cache writes jump.

**Look for:** the "without caching" cost next to the real one in the status line.

### Stage 5: structured output

- Run `/audit` at `/effort low`, then at `/effort high`, and compare the results with the answer key.
- With `/raw` on, run `/audit` and read `output_config.format` in the request: the JSON Schema generated from the Zod schema. The enums appear only as hints in `description`, so the Zod check afterwards is what enforces them.
- Add a field to the schema in `src/audit.ts`, for example `estimated_minutes_lost: z.number()`, and run `/audit` again.

**Look for:** `/audit` sends no tools, so its prompt starts differently from the chat's, and its first run writes a cache entry of its own.

### Stages 6 and 7: tools

- "How many km does R4 drive, and why so far?" Claude should call `evaluate_route` and `distance`, and point to S404 (15.7 km from the depot).
- "Fix R3's late stop." Watch Claude try stop orders with `evaluate_route` until nothing is late. The expected fix is visiting S302 before S301.
- "Can S501 fit on any route?" This takes several simulations, possibly in parallel.
- Type `/history` to see the `tool_use` and `tool_result` messages, and turn on `/raw` to see the exact JSON each way.

**Look for:** the number of requests in the turn's status line. Each round of tool calls is another request, each with its own cost line. Stage 7 behaves the same as stage 6; to compare the hand-written loop with the tool runner:

```bash
git diff stage-6 stage-7 -- src/chat.ts src/tools.ts
```

### Stage 8: server tools

- "Chart each van's load against its capacity." Python runs in Anthropic's sandbox, and the chart is saved as a PNG in `outputs/`.
- "Is anything happening in São Paulo today that could slow deliveries?" This uses web search, at $0.01 per search. The dataset's service date is 2026-10-06.
- "Using Python, find the two stops furthest apart." Then ask a follow-up that uses files from that answer: the container, and its files, carry over between turns.
- Type `/history` to see the `container_upload` block in your first message and the `server_tool_use` and result blocks.

**Look for:** server tools never stop the turn with `tool_use`. The call and its result arrive together in the same response. The first question uploads `routes.json` through the Files API; it stays in your Anthropic workspace and is reused on later runs.

### Stage 9: first managed agent

- Run `npm run agent:setup`. It prints the ids it created; run it again and it reports the agent is up to date.
- Change the instructions in `src/agent/config.ts` and run setup again: the agent moves to version 2 instead of being created again.
- Run `npm run agent` and open the Console link it prints. Ask "Why is R3 late?" and follow the same turn in the terminal and in the Console.
- Ask "How many km does R4 drive?". When the agent calls `distance` or `evaluate_route`, your program runs it (`custom tool ›`) and sends the result back, while `bash` and web search run on Anthropic's side (`tool ›`).
- Turn on `/raw` to see each event: `session.status_running`, `agent.custom_tool_use`, `session.status_idle` with `requires_action`, then `end_turn`.

**Look for:** nothing is resent between turns, because the session keeps the conversation. Each session has a spending cap ($5 since stage 11), and the status line shows the session's cost so far, which includes the container's running time. On `exit` the session is archived: it stays viewable in the Console, read-only.

### Stage 10: files in, files out

- Run `npm run agent:setup` first. It updates the environment (pandas and matplotlib are now preinstalled) and moves the agent to a new version whose system prompt no longer contains the dataset. Until you do, `npm run agent` warns that `config.ts` changed.
- Run `npm run agent` and ask "Write a report of today's problems, with a chart of the load per van." The agent reads `/mnt/session/uploads/routes.json` with Python, saves the files to `/mnt/session/outputs/`, and your program downloads them into `outputs/<session id>/`.
- Ask a follow-up such as "Add the R4 detour to the report." The container keeps its files during the session, so the agent edits the same report, and the new version is downloaded over the old one.
- Ask a plain question, like "Which van is overloaded?", and watch the agent read the file first: the data is no longer in its prompt.
- Copy the session id printed at the start (`sesn_…`) and, after you exit, run `npm run agent:outputs <session id>`. The files are still there: outputs stay in the Files API after the session is archived.

**Look for:** answers now start with the agent reading the file, an extra step that stage 9 didn't need. In exchange, the data costs tokens only when it's used: if the agent pulls out just what it needs with Python, much less of the file enters the model's context than when all of it sat in the system prompt. Output files can take a second or two to show up after the turn, which is why the download retries.

### Stage 11: outcomes

- Run `npm run agent` and type `/report`. Instead of a message, the chat sends a `user.define_outcome` event: the task, the rubric in `data/report-rubric.md`, and up to 3 checks.
- Watch for `grader ›` lines. After each attempt, a separate grader checks the report against every criterion. On `needs_revision` it says what's missing, and the agent revises without you sending anything.
- Make the rubric stricter, for example "Each fix was checked with the evaluate_route tool, and the report says so", and run `/report` again in a new session to see whether it takes more attempts.
- Compare the downloaded report with the answer key above. The rubric never lists the planted problems; it only requires every route and unassigned delivery to be covered, with numbers.

**Look for:** the session stays `running` through the revisions and only goes idle once the outcome is over: `satisfied`, `max_iterations_reached`, `failed` or `interrupted`. The status line counts the grader's tokens separately: grading is billed too.
