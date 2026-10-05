# agents-playground

Learning the Claude API hands-on by building one project end to end: a **route analyst**, an assistant that answers questions about delivery-route data. It starts as a single API call and ends as a hosted Managed Agent.

## Setup

```bash
npm install
cp .env.example .env   # then paste your API key into .env
npm start -- "your question"
```

## Code layout

| File | What it covers |
|---|---|
| `src/index.ts` | The REPL: reads commands and calls the modules below |
| `src/client.ts` | The Anthropic client, the model, refusal fallbacks |
| `src/chat.ts` | Chat turns: history, streaming, thinking |
| `src/prompt.ts` | System prompt, grounding, prompt caching |
| `src/data.ts` | Loads `data/routes.json` |
| `src/audit.ts` | `/audit`: structured output with Zod |
| `src/settings.ts` | Effort and raw view, changed by commands |
| `src/output.ts` | Printing raw JSON, usage and cost |

## Roadmap

Each stage builds on the one before it. The point is to see what each layer adds and what it costs you to own.

### Part 1: Messages API basics

- [x] **1. First call**: request shape, content blocks, `stop_reason`, token usage and cost
- [x] **2. Chat loop**: multi-turn REPL with a system prompt. The API is stateless, so you keep the history.
- [x] **3. Streaming + thinking**: stream tokens as they arrive, show thinking summaries, tune effort
- [x] **4. Grounding + caching**: put a route dataset in the prompt, use prompt caching, watch `cache_read_input_tokens`
- [x] **5. Structured output**: get typed JSON back, validated against a Zod schema

### Part 2: You run the agent loop

- [ ] **6. Tools, manual loop**: define `list_routes` / `get_route` / `distance` tools and drive the `tool_use` → `tool_result` loop yourself
- [ ] **7. Tool runner**: replace that loop with the SDK's tool runner
- [ ] **8. Server tools**: let Claude run code and search the web on Anthropic's side

### Part 3: Anthropic runs the agent loop (Managed Agents)

- [ ] **9. First managed agent**: create the agent and environment once, start a session per run, stream events
- [ ] **10. Files in, files out**: upload the dataset, have the agent analyze it in its sandbox and return a report or chart
- [ ] **11. Outcomes**: give the agent a rubric and let a grader send its work back until it passes
- [ ] **12. Going further**: memory across sessions, a scheduled nightly report, multiple agents
