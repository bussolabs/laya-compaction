# Fine-tuning Laya for laya-compaction

Out of the box Laya has never seen a compaction decision. Fine-tuning on a few
hundred of them is what makes its answers useful. This folder has everything
needed to build that data and train on it.

## What is here

| File | What it is |
| --- | --- |
| `questions.json` | The two questions the compactor asks about every tool call, as templates. Generated from the source (`npm run tuning:questions`); never edit it by hand. |
| `examples.jsonl` | 16 synthetic examples (37 tool calls, 74 questions). Read them to learn the format. |
| `dataset.jsonl` | Empty. Your examples go here. |
| `build-examples.ts` | The script that wrote `examples.jsonl` from small hand-written transcripts. Copy it to write your own. |
| `validate.ts` | Checks a file line by line (`npm run tuning:validate -- <file>`). |

Everything here is invented. The repository is public, so **never put real
session content in these files**: no real code, paths, logs, names or keys.

## The format

A `.jsonl` file has **one example per line**. Each line is a JSON object with
three parts:

- `state`: what Laya reads. For this project it is always the object the
  compactor builds: `context` (a fixed explanation), `goal` (the last user
  prompts) and `history` (the conversation, tool outputs replaced by their
  size).
- `questions`: two `noul` (yes/no) questions per tool call.
- `gold`: the right answer for each question, with the same keys.

The questions come from `questions.json`, filled in for each call:

| Placeholder | Filled with |
| --- | --- |
| `{id}` | the call's short id: `t1`, `t2`, … in the order the calls appear |
| `{tool}` | the tool name: `Read`, `Bash`, `Edit`, … |
| `{chars}` | the length of the tool's output |

So the questions about call `t3`, a `Read` that returned 2,410 characters, are
`call_t3` and `result_t3`, and their instructions name `t3 (Read, 2410
chars)`. The question ids change per call; the wording around them never does.
Laya only reads the wording, so it must match production exactly. That is why
the easiest way to write an example is to write a small transcript and let the
real code build the line (see below).

A gold answer looks like this:

```json
"result_t3": {"label": "true", "probabilities": {"false": 0.3, "true": 0.7}}
```

- `probabilities` has exactly `"false"` and `"true"`, and they add up to 1.
- `label` is the more likely of the two.
- A sure answer is `1.0` / `0.0`. A doubtful one is split, e.g. `0.7` / `0.3`:
  the model learns how sure to be, too. Never `0.5` / `0.5`.

## What the two questions mean

- **`call_tN`**: does *knowing this call was made, with its input*, still
  matter? Yes for an edit that changed a file, a test run whose outcome the
  next step depends on, a read of the file being worked on. No for a typo'd
  command, a search in a folder the user excluded, a superseded task list.
- **`result_tN`**: is the *full output* still needed word for word, so that
  re-running the tool would not do? Yes for test failures not fixed yet, a type
  definition the next edits rely on, docs the code is about to follow. No for
  an old read of a file edited since, an error already fixed, a log whose one
  useful line was already quoted.

When the call is kept but the result is not, the compactor keeps the call and
the first 300 characters of the output.

## Write your examples

1. Copy `build-examples.ts` to a new file, e.g. `tuning/my-dataset.ts`
   (the folder is tracked by git: keep it synthetic, or keep the file outside
   the repository).
2. Replace the `scenarios` list with your own transcripts. A scenario is a few
   messages built with `user()`, `assistant()` and `tool()`, plus a gold pair
   `g(keepCall, keepResult)` for every tool call. The numbers are the
   probability of "yes".
3. End every scenario with an assistant message and a user message. The newest
   two messages are pinned (never asked about), so this keeps every tool call a
   candidate.
4. Build and check:

   ```sh
   npx tsx tuning/my-dataset.ts tuning/dataset.jsonl
   npm run tuning:validate -- tuning/dataset.jsonl
   ```

The builder fits each state into the default budget (4096-token window, 3984
for the state), exactly as at runtime. If you plan to run with a larger
`maxLen`, pass the same options to `resolveOptions` in your copy, so the
training states look like the production ones.

## Rules for good examples

- **How many:** start with a few hundred tool calls, mixed tools and outcomes.
  The Laya authors' benchmark trains on 6,000 decisions.
- **Balance:** roughly as many "keep" as "drop" answers, for both questions.
- **Same wording everywhere:** never change the instructions. If the
  compactor's questions change, regenerate `questions.json` and rebuild.
- **Hold out ~20%:** move about one line in five to `tuning/test.jsonl` before
  training and never train on it. It tells you whether the model really got
  better.
- **Think like the assistant:** answer from what the next step needs, not from
  how big the output is.

## Train

You need Python 3.10+ and the `laya` package. The output is a checkpoint
directory (`model.safetensors`, `encoder/`, `tokenizer/`,
`rl_agent_config.json`).

### Option A: `laya-train` (Mac, Linux or any GPU)

`laya-train` reads this JSONL format directly (rows with `state`, `questions`,
`gold`) and runs on CUDA, Apple Silicon (MPS) or CPU.

```sh
python -m pip install laya
# 1. check the data without training
laya-train --data tuning/dataset.jsonl --base multilingual --max-len 4096 --dry-run
# 2. train, with the held-out file as evaluation
laya-train --data tuning/dataset.jsonl --eval tuning/test.jsonl \
           --base multilingual --max-len 4096 --out ./laya-compaction-checkpoint
```

- `--base multilingual` matches what the compactor uses (local mode always
  asks for `multilingual`, and a fine-tune replaces it).
- Pass `--max-len 4096` (or whatever `maxLen` you run with) so training sees
  as much of the state as production does. A wider window needs more GPU
  memory; lower `--micro-batch` if it runs out.
- `--dry-run` lists questions it would skip and why (for example
  `options_beyond_max_len`).
- The run prints accuracy on `test.jsonl` and warns when calibration rests on
  too few examples.

### Option B: Kaggle (free 2×T4 GPUs)

Use the official notebook,
[`laya_finetune_typed_decisions_2xT4_kaggle.ipynb`](https://github.com/NandhaKishorM/laya/blob/main/notebooks/laya_finetune_typed_decisions_2xT4_kaggle.ipynb)
(Kaggle: File → Import Notebook; Accelerator GPU T4 x2, Internet on). Upload
`dataset.jsonl` with Add Input → Upload, then in cell 3 replace
`ds_train = load_dataset(...)` and the `for row in ds_train:` loop with:

```python
rows = [json.loads(line) for line in open("/kaggle/input/<your-upload>/dataset.jsonl") if line.strip()]

items = []
for row in rows:
    state, questions, gold = row["state"], row["questions"], row["gold"]
    for qid, q in questions.items():
        if qid in gold:
            it = build_training_item(state, q, gold[qid])
            if it:
                items.append(it)
```

In the same cell use the multilingual checkpoint: replace
`model_dir = snapshot_download(MODEL_ID)` with
`model_dir = os.path.join(snapshot_download(MODEL_ID, allow_patterns=["multilingual/*"]), "multilingual")`
(not tried; the notebook trains the English one). Run up to cell 5. Cells 6–7 score the official English test set, not yours:
skip them or point them at `test.jsonl` the same way. In cell 8 change
`NEW_REPO` to a repository of your own before publishing. Note that the
notebook trains with `max_len` 1024 while it builds the items with the base
checkpoint's own value.

The [Apple Silicon script](https://github.com/NandhaKishorM/laya/blob/main/notebooks/laya_finetune_typed_decisions_mps.py)
is the same loop on one Mac, but it downloads the benchmark data itself; for
your own file Option A is the shorter path.

## Use the result

The checkpoint directory is used as is; there is no export step.

- **Local mode:** point `LAYA_MODEL_DIR` at it and restart the local server
  (`pkill -f laya_serve.py`; the next compaction starts it again). The server
  serves your checkpoint under the name `multilingual`, which is what the
  compactor asks for.

  ```sh
  export LAYA_MODEL_DIR="$PWD/laya-compaction-checkpoint"
  ```

- **Remote mode:** run the launcher on a server with the checkpoint and a key,
  then set `LAYA_URL` and `LAYA_API_KEY` on the clients (and `LAYA_MODEL=multilingual`):

  ```sh
  LAYA_HOST=0.0.0.0 LAYA_PORT=8000 LAYA_API_KEY=change-me \
  LAYA_CHECKPOINT=/srv/laya-compaction-checkpoint \
    uv tool run --python 3.12 --from "laya[serve]==0.4.0" python serve/laya_serve.py
  ```

Measure before and after on `test.jsonl`: the run's own report, or
`laya-evals run tuning/test.jsonl` against the served model.

## Not verified here

These steps were written from the Laya sources and docs, not run end to end:

- training with `laya-train` or the notebook on this dataset, and the
  notebook's switch to the multilingual checkpoint;
- `laya-evals run` on the `gold`-only format (its docs describe `expected`).
