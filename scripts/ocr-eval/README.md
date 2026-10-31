# OCR evaluation harness

Compares vision models on handwritten student pages against your own ground truth, so you can choose a model
(and image preprocessing) for the `gpt_vision_exact` OCR path with evidence. It never changes production code and
it is read-only on your data.

Marking depends on faithful transcription, so besides CER and WER it measures **over-correction**: a model
silently replacing a student's mistake with the corrected form.

## Safety in one minute

- **Dry run is the default.** Models are simulated, nothing touches the network, nothing costs money.
- **Real, paid calls need `--live` and `--confirm N`**, where `N` is exactly the number of calls the plan prints.
  Without `--live` there is no network access at all; `--confirm` without `--live` is refused.
- `--max-cost-usd X` stops the run once X has been spent. If the API reports no cost and no price is known, the
  cap cannot be enforced and the run stops after the first call (use `--price model=in:out`).
- One attempt per call. No retries, so spending is never hidden. `--resume --run-id ID` reuses calls that already
  succeeded.
- **The API key** is read from `OPENROUTER_API_KEY` in the environment, only for `--live`. It is sent only in the
  `Authorization` header and is redacted from every log line, error message and file. Nothing reads `.env` files.
- **Your data is never copied.** Photos and ground truth are read in place from `OCR_EVAL_DIR`. Results go to
  `OCR_EVAL_OUT` (outside the repo). The tool refuses an output folder inside the repo unless it is the git-ignored
  default `backend/tmp/ocr-eval-results/`.
- `results.csv` and `summary.md` contain numbers and names only. `raw/` (model outputs), `diffs/` and
  `mistakes-drafts/` contain student text: keep them outside the repo.

## Setup (PowerShell)

```powershell
$env:OCR_EVAL_DIR = 'D:\ocr-eval'            # photos + ground truth, outside the repo
$env:OCR_EVAL_OUT = 'D:\ocr-eval\results'    # results, outside the repo
cd backend
node scripts/ocr-eval/run.cjs --help
```

## Dataset layout

```
image1.jpeg   image1.txt   [image1.mistakes.tsv]
image2.jpg    image2.txt
image10.png   image10.txt
```

- Any `<name>.jpg|.jpeg|.png` with a matching `<name>.txt`. Names sort naturally (`image2` before `image10`).
  Sub-folders (such as `results`), hidden files and unmatched files are ignored; unmatched files are reported.
- **Ground-truth conventions** (the prompt asks the models for the same):
  crossed-out words omitted; printed header text and name/date excluded; the student's handwritten copy of the
  question included.
- **`[?]`** marks a part of the ground truth you could not read. Both a standalone `[?]` and a suffix such as
  `word[?]` are supported. That region is ignored: it may match up to `--wildcard-span` (default 2) model words, or
  none, and those words are not scored. Errors next to it still count.
- **`<name>.mistakes.tsv`** (optional) lists genuine student mistakes for the over-correction metric, one per line:

  ```
  # student form <TAB> correct form
  powerfull	powerful
  She go	She goes
  i	I
  ```

  Matching ignores surrounding punctuation but is case-sensitive, so capitalisation slips are listed explicitly.
  Malformed lines stop the run with the file name and line number.

## Typical workflow

```powershell
node scripts/ocr-eval/run.cjs --inspect                       # read-only check: counts and file names only
node scripts/ocr-eval/run.cjs --models fake/perfect,fake/noisy # dry run, simulated
node scripts/ocr-eval/run.cjs --check-models --models qwen/qwen3.8-27b,vendor/other-model   # free catalog lookup
```

Build the mistakes lists once with real model output (a first live run, or a resumed one), then add the lists:

```powershell
node scripts/ocr-eval/run.cjs --models <ids> --live --confirm <N> --suggest-mistakes
# review <run>\mistakes-drafts\*.draft.tsv, keep genuine student mistakes, save as <name>.mistakes.tsv in OCR_EVAL_DIR
```

A small first live run is a good idea (the plan line tells you the number to confirm):

```powershell
$env:OPENROUTER_API_KEY = '<your key>'      # in your shell only
node scripts/ocr-eval/run.cjs --models qwen/qwen3.8-27b --limit 2 --live --confirm 4 --max-cost-usd 0.50
```

(2 photos x 2 variants x 1 model = 4 calls.) Then the full set, and `--prompt production` for the current Qwen model.

## Options

| Option | Meaning |
|---|---|
| `--models a/b,c/d` | OpenRouter model ids. Dry runs also accept `fake/perfect`, `fake/noisy`, `fake/autocorrect`, `fake/reasoning`; any other id is simulated as a generic noisy reader. |
| `--variants` | `original`, `preprocessed`, `client-export` (default: first two) |
| `--prompt` | `plain` (default) or `production` |
| `--live --confirm N` | real paid calls |
| `--max-cost-usd X`, `--price model=in:out` | cost cap; USD per million tokens for estimating cost |
| `--resume --run-id ID`, `--run-id ID` | reuse saved successful calls; name the run folder |
| `--provider NAME` | pin one provider (`provider.only`) |
| `--sort latency\|throughput\|price\|default` | provider sort order. `default` sends no sort. Production uses `latency` for Qwen. Cannot be combined with `--provider`. |
| `--limit N` | first N photos |
| `--suggest-mistakes` | write draft mistakes files into the run folder |
| `--no-catalog` | live: skip the free catalog check |
| `--inspect`, `--check-models` | read-only dataset check; free catalog lookup |

## What every model gets

- The **same prompt** (`plain`: the verbatim-transcription rules of the production prompt, plain-text output;
  `production`: the production Qwen prompt and strict JSON schema, parsed with the production validator).
- `temperature: 0`, `reasoning: {effort: "none"}`, `max_tokens: 16000`, `require_parameters: true`,
  `allow_fallbacks: false`. Production sends no temperature at all, so this is deliberately different.
- A parameter is left out only when the model's catalog entry says it cannot take it (and the summary says so).
  Unknown models in the catalog stop a live run.

**Reasoning check.** Every call is flagged `reasoning_not_off` when the response reports reasoning tokens or
includes reasoning text. Such models are not comparable on cost, latency or accuracy.

**Serving provider.** Every call logs which provider served it (if the response reports one). OpenRouter can route
one model id to different providers, possibly with different quantizations; use `--provider` and `--sort` to
test the effect.

## Image variants

- `original` - exactly what production sends (the production `orientImage`: EXIF rotation only).
- `preprocessed` - auto-rotate, grayscale, 1-99 percentile contrast stretch, light sharpen (sigma 0.8), JPEG q92.
- `client-export` - approximates what the new frontend crop export uploads (JPEG q92, size-fitted to 8 MB,
  long edge kept at 2000 px or more). Browser canvas scaling differs slightly from sharp.

## Metrics

- **CER / WER**, case-sensitive and case-insensitive, via edit distance over the normalised text. Whitespace and
  line breaks do not count; punctuation stays attached to its word; typographic quotes and dashes are treated as
  plain ones. Averages are per photo (every photo weighs the same); failed calls are excluded and counted.
- **Over-correction** = listed student mistakes the model replaced with the correct form / listed mistakes found.
  Each occurrence is `preserved`, `overcorrected`, `misread` (anything else) or `dropped`. Without a mistakes list the
  value is `n/a`, never 0. "Unlisted substitutions" counts model changes that are not on your list.
- **Cost per page** is `usage.cost` from the response. If the API reports none, it is estimated from tokens using the
  catalog price or `--price`.
- **Latency** is wall-clock time from sending the request to reading the whole response.
- **Paired preprocessing comparison**: only photos that succeeded for both variants; change in CER/WER versus
  `original`. With about ten photos, differences under a percentage point are noise.

## Output (`OCR_EVAL_OUT/<run id>/`)

`results.csv` (one row per photo x model x variant), `summary.md`, `run.json`, `diffs/` (side by side ground truth
vs output for the worst 3 photos per model and variant, skipping perfect ones), `mistakes-drafts/` (with
`--suggest-mistakes`), `raw/` (each call's output; used by `--resume`).

## Limits and unverified assumptions

- The request fields follow the production request and OpenRouter's documented API as I know it. Not verified
  without a paid call: whether each model honours `reasoning: none`, whether responses carry a `provider` field and
  `usage.cost`, and whether `provider.only` pins as expected. The first small live run confirms these; the report
  shows `unknown`/`n/a` rather than guessing.
- Dry-run numbers are synthetic. They test the harness, not any model.
- Calls run one at a time, to keep latency measurements clean.
- `[?]` regions can absorb up to `--wildcard-span` model words at no cost.

## Tests

`npx jest --runInBand tests/ocrEvalMetrics.test.js tests/ocrEvalDataset.test.js tests/ocrEvalHarness.test.js`
