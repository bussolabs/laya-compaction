# laya-compaction

> A port of [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)
> by tamaratran. The compaction logic, the state fitting and the Claude Code
> plugin are theirs; this fork swaps TypeSafe Jev for
> [Laya](https://github.com/NandhaKishorM/laya), the open-source,
> Jev-compatible decision model, so it runs on your own machine or your own
> server.

Claude Code plugin that replaces the compaction summary with Laya decisions:
every tool call and result is scored, stale ones are dropped or truncated,
everything kept stays verbatim. Also usable as an npm library.

## What and why

Most context compaction asks an LLM to summarize old turns. A summary is
lossy: a file path, exact error, constraint, or command can disappear even when
it matters later. This library never rewrites anything. It only deletes tool
calls and tool results Laya says are no longer needed, and it asks Laya while
showing it the conversation. User and assistant text stays verbatim and in
order.

## Two ways to run Laya

Both talk to [`laya-serve`](https://github.com/NandhaKishorM/laya/blob/main/docs/http-api.md),
Laya's Jev-compatible HTTP server.

| Mode | When | What happens |
| --- | --- | --- |
| **Local** | `LAYA_URL` is not set | One shared server on `127.0.0.1:8765`, started on demand and left running. Every request asks for the **multilingual** checkpoint. |
| **Remote** | `LAYA_URL` is set | Your own `laya-serve`, anywhere, optionally behind a bearer key. |

| Variable | Mode | Meaning |
| --- | --- | --- |
| `LAYA_URL` | remote | Base URL of `laya-serve`, e.g. `https://laya.example.com`. Requests go to `$LAYA_URL/v1/systemone`. |
| `LAYA_API_KEY` | remote | Sent as `Authorization: Bearer …` only when set (the server's own `LAYA_API_KEY`). |
| `LAYA_MODEL` | remote | Checkpoint name (`english`, `multilingual`, `typed-decisions`). Omitted when unset, so the server routes by language. |
| `LAYA_LOCAL_PORT` | local | Port of the local server. Default `8765`. |
| `LAYA_MODEL_DIR` | local | A fine-tuned checkpoint directory (`model.safetensors`, `rl_agent_config.json`, …) served in place of the built-in multilingual one. See [`tuning/`](tuning/README.md). |

### Local mode

Before a request the client calls `GET /health` on the local port. When
nothing answers it starts the server **detached**, so it outlives Claude Code
or your script, and waits for it:

```sh
uv tool run --python 3.12 --from "laya[serve]==0.4.0" python serve/laya_serve.py
```

- **Needs [uv](https://docs.astral.sh/uv/).** Without it local mode fails with
  an error naming uv (the plugin then falls back to Claude Code's summary).
- **First start:** uv installs Python 3.12 and the server's packages, and the
  multilingual checkpoint (~1.3 GB) is downloaded. Allow a few minutes; the
  client waits up to 10. Later starts take ~25 s.
- **Memory:** ~1.5 GB while the model is loaded. After 15 minutes without
  requests the server unloads it and reloads it on the next one.
- **Logs:** `~/.cache/laya-local/serve.log`. A lock file next to it keeps two
  callers from starting two servers.
- **Stop it:** `pkill -f "laya_serve.py 8765"` (use your port), or
  `pkill -f laya_serve.py` for every local server.

`serve/laya_serve.py` is a ten-line launcher around the official app: with
`LAYA_CHECKPOINT` (which the client sets from `LAYA_MODEL_DIR`) it serves that
checkpoint under the name `multilingual`.

### Remote mode

Run the same launcher on a server, protected by a key:

```sh
LAYA_HOST=0.0.0.0 LAYA_PORT=8000 LAYA_API_KEY=change-me \
  uv tool run --python 3.12 --from "laya[serve]==0.4.0" python serve/laya_serve.py
```

Add `LAYA_CHECKPOINT=/path/to/checkpoint` to serve a fine-tune. Clients set
`LAYA_URL` and `LAYA_API_KEY`.

## Window, speed and the truncation guard

Laya reads one question at a time, and the state shares a **token window**
(`max_len`) with that question. Every request sends `max_len`; the default is
**4096** (the multilingual checkpoint reads up to 8192, and the Laya authors
measured accuracy holding up to ~4,000 tokens). The state budget follows:

| Option | Default |
| --- | ---: |
| `maxLen` | `4096` |
| `maxStateTokens` | `maxLen − 112` = `3984` |

The 112 tokens are kept for the question header. `maxLen` trades speed for
context: on Apple silicon (MPS) a question on a large state takes ~0.6 s at
4096, so **~1 minute for 50 tool calls** (two questions each); at 1024 it is
about three times faster, but the state builder has to abridge much more and
long sessions stop fitting.

Token counts are estimated without Laya's tokenizer, so they are approximate.
The safety net is the server's `usage.truncated`: if any answer was computed
on a state the server had to cut, compaction throws instead of deciding on
partial context, and the plugin falls back to Claude Code's summary.

## How it works

1. Every `tool_use` is paired with its `tool_result` by `tool_use_id`. Calls in
   the first message or in the newest `preserveRecentMessages` messages are
   pinned and never touched.
2. The **state** sent to Laya is the whole conversation so far, oldest first,
   with every tool result replaced by a short note (`ok, 4213 chars (omitted)`).
3. The state is fitted into `maxStateTokens` in stages, each applied only if
   the previous one was not enough: tool inputs truncated to 1000, then 200,
   then 60 characters; long texts abridged to head + tail, oldest non-pinned
   messages first; old non-pinned messages collapsed to a
   `[… N chars omitted …]` note; old tool calls reduced to one line each; old
   call-less messages left out; runs of old call-only messages folded into one
   entry. If it still does not fit, compaction throws. Tokens are estimated
   without a tokenizer (calibrated upstream against Jev's counts), so the
   truncation guard above backs them up.
4. For every non-pinned call Laya gets two `noul` questions: should the
   **call** stay, and should the **result** stay verbatim. The exact wording is
   in [`tuning/questions.json`](tuning/questions.json).
5. Questions are grouped into requests of at most `maxRequestTokens`
   (estimated state plus questions); the same state goes with every request.
6. Decisions per call, against `keepThreshold`:
   - `keepResult ≥ threshold` → keep call and result;
   - else `keepCall ≥ threshold` → keep the call, truncate the result to its
     first `truncateHeadChars` characters plus a one-line note;
   - else → remove the call together with its result.
7. The message list is rebuilt: a message that loses all its content is
   removed, untouched messages are returned as the same objects, and no result
   is ever left without its call.

Laya failures, malformed answers, a truncated state, a server that cannot be
started, or a history that cannot be fitted throw; the caller (or the Claude Code hook) decides what to fall back
to.

## Library

```sh
npm install laya-compaction
```

```ts
import { compactMessages, reductionRatio, type Message } from 'laya-compaction';

const transcript: Message[] = [
  { role: 'user', text: 'Fix the failing test. Never edit src/generated.', toolUses: [] },
  {
    role: 'assistant',
    text: '',
    toolUses: [{ tool_use_id: 'toolu_1', tool: 'Read', input: { file_path: 'src/a.ts' } }],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_1', text: '…file…' }] },
  // …
];

// Local server by default (started if needed); remote when LAYA_URL (or `url`) is set.
const result = await compactMessages(transcript, { preserveRecentMessages: 4 });
console.log(result.messages, result.decisions, result.stats);
if (reductionRatio(result) < 0.25) {
  // not worth it: keep the original transcript, or summarize instead
}
```

`Message` is a subset of Claude Code's `SessionMessage`, so a session transcript
can be passed in as is.

To bring your own transport, implement `LayaAsker` (one `ask(state, questions)`
method) and call `compact(messages, asker, options)`. `LayaClient` and
`startLocalServer` (resolves with the local base URL) are exported, and so are
`buildLayaRequest`, `parseLayaResponse` and the building blocks
(`collectToolCalls`, `fitState`, `batchCalls`, `decideCall`, `applyDecisions`).

### Options

| Option | Default | Description |
| --- | --- | --- |
| `url` | `LAYA_URL` | `laya-serve` base URL; unset means local mode |
| `apiKey` | `LAYA_API_KEY` | Bearer key, sent only when set |
| `model` | `LAYA_MODEL` | Remote checkpoint name, omitted when unset (local always uses `multilingual`) |
| `localPort` | `LAYA_LOCAL_PORT` or `8765` | Port of the local server |
| `modelDir` | `LAYA_MODEL_DIR` | Fine-tuned checkpoint for the local server |
| `fetch` | native `fetch` | Injectable fetch implementation for tests |
| `goal` | last 3 user prompts | Ongoing task description included in the state |
| `keepThreshold` | `0.5` | Minimum keep probability for a call or result to stay |
| `preserveRecentMessages` | `6` | Newest messages never touched (the first is always kept) |
| `maxLen` | `4096` | Laya's token window, sent as `max_len` |
| `maxStateTokens` | `maxLen − 112` | Estimated token ceiling for the state |
| `maxRequestTokens` | `30000` | Estimated ceiling for state plus one batch of questions |
| `truncateHeadChars` | `300` | Characters of a dropped tool result retained before its note |

`result.stats` reports message and character counts before and after, the
per-reason decision counts, the state size in estimated tokens, which fitting
stage was needed, and the number of requests.

## Claude Code plugin

The repository root is a Claude Code function-hook plugin: `hooks/laya.ts` is
a thin adapter that feeds `session.compact` transcripts through `src/` and
falls back to Claude Code's built-in summary on errors or insufficient
reduction. Remote mode uses the engine's `$.http.fetch`; local mode also
starts the shared server through `$.process.run` (a `sh` script that
backgrounds it and returns at once) and waits with `$.clock`.

Function hooks are an early-access Claude Code feature (2.1.274+). In
`~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
```

Add `"LAYA_URL"` (and `"LAYA_API_KEY"`) there for remote mode; leave them out
for local mode, which needs `uv` on the `PATH`.

Then add this repository as a plugin marketplace and install the plugin:

```sh
claude plugin marketplace add bussolabs/laya-compaction
claude plugin install laya-compaction@laya-compaction
```

From then on `/compact` (and auto-compaction) goes through Laya. See
[`hooks/README.md`](hooks/README.md) for the options. To run from a checkout:
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .`

## Fine-tuning

On the Laya authors' typed-decisions benchmark the base checkpoints score
close to chance (0.36 against 0.32 random) and a fine-tuned one 0.77:
fine-tuning on your own decisions is where accuracy comes from.
[`tuning/`](tuning/README.md) has the exact questions, synthetic examples, a
validator and a step-by-step guide.

## Limitations

- Only tool calls and results are candidates; text messages are never removed
  or shortened in the output (they are only abridged in the state Laya sees).
- The window (4096 tokens by default) is far smaller than Jev's 32k; a long
  session may not fit, and then the plugin falls back to the summary.
- The base checkpoint is not trained on compaction decisions: in our smoke
  test it kept everything. Fine-tune it (see `tuning/`).
- Token sizes are estimates from character counts, not Laya's tokenizer.
- A probability is not a proof that a result is safe to delete. The assistant
  can always re-run the tool.
- Speed: ~0.6 s per question at 4096 on Apple silicon (two questions per tool
  call).

## Development

```sh
npm install
npm run typecheck        # library + hook
npm test
npm run build
npm run validate:plugin  # claude plugin validate
npm run demo             # live check: local server, or LAYA_URL
```

The unit tests use a fake Laya and a fake server driver; they never start or
contact a server.

`demo/LayaDemo` is a scripted macOS SwiftUI animation of the flow, meant to be
screen recorded; it never calls Laya (`demo/LayaDemo/build.sh`).

## License

MIT. Original work © fast-jev-compaction authors; Laya weights are Apache 2.0
by Convai Innovations.
