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
  succeeded. See "When calls fail" for how failures, costs and `--max-failures` work.
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
| `--models a/b,c/d` | OpenRouter model ids. Dry runs also accept `fake/perfect`, `fake/noisy`, `fake/autocorrect`, `fake/reasoning`, `fake/needs-reasoning` (rejects reasoning `none`/`minimal`, accepts `low`+), `fake/always-fails`; any other id is simulated as a generic noisy reader. |
| `--variants` | `original`, `preprocessed`, `client-export` (default: first two) |
| `--prompt` | `plain` (default), `production`, or a candidate design: `plain-first`, `production-trim`, `lean-json` (see "Candidate designs") |
| `--temperature 0\|omit` | `0` (default) sends `temperature: 0`; `omit` sends no temperature, as production does |
| `--rescore RUN_ID` | offline: rebuild `results.csv`, `summary.md`, `run.json` and `diffs/` from the run's saved `raw/` calls. No network, no key. Add `--prompt` only for old runs whose raw files do not record it. |
| `--live --confirm N` | real paid calls |
| `--max-cost-usd X`, `--price model=in:out` | cost cap; USD per million tokens for estimating cost |
| `--reasoning-for model=MODE` | reasoning setting for one model, repeatable. `MODE`: `none` (default for every model), `minimal`, `low`, `medium`, `high`, `omit` (send no reasoning parameter). Recorded per model in `summary.md` and `results.csv`. |
| `--max-failures N` | skip a model's remaining calls after N consecutive failures (default 5); other models continue |
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

**Models that reject `reasoning: none`.** Some models cannot switch thinking off, and the API answers
`PARAMETER_REJECTED`. Give such a model its own setting, for example
`--reasoning-for google/some-model=low` (the lowest value it accepts) or `--reasoning-for vendor/other=omit`
(send no reasoning parameter). The setting is never silent: `summary.md` has a **Request settings per model**
table (temperature, reasoning requested -> sent, max tokens, sort, pinned provider, prompt, output), a warning when
models did not all receive the same reasoning setting, and `results.csv` records `reasoning_mode` and
`reasoning_sent` for every call. A model that still reasons is flagged, and its reasoning tokens are in the CSV.

## When calls fail

- A failed call is recorded (code, HTTP status, the API's own error text, and the parameter it names) and the run
  **continues** with the next call. `results.csv` has `http_status`, `error_detail` and `rejected_param` (the last
  columns), and `summary.md` has a **Failed calls** section. Error text is API text only, bounded, with the key and
  long encoded blobs removed.
- **Cost.** An HTTP error response (rejected before anything is generated) counts as no charge and never trips
  `--max-cost-usd`. A call that produced output or reported a cost counts toward the cap. A call that ended with no
  response at all (timeout, network error) may have been billed: it is flagged `may_be_billed` and left out of the
  totals. The cap is still enforced on successful calls, and a successful call with no cost and no price still stops
  a capped run because the cap cannot be enforced.
- **`--max-failures N`** (default 5) counts consecutive failures per model; a success resets the count. At N, that
  model's remaining calls are recorded as `skipped` (they are not saved, so `--resume` tries them again) and the other
  models carry on.
- **Run-level stops.** An authentication error (HTTP 401/403) or insufficient credits (HTTP 402) stops the whole run,
  since every later call would fail identically. A rejected parameter (`PARAMETER_REJECTED`) skips that model's remaining
  calls at once, because the same request would be rejected again.

**Serving provider.** Every call logs which provider served it (if the response reports one). OpenRouter can route
one model id to different providers, possibly with different quantizations; use `--provider` and `--sort` to
test the effect.

## Candidate designs

Each design is one call per page. Its output is converted to the production wire JSON and checked by the production
validators (`validateWire` + `validateCanonical`), so `validation` shows whether production would accept the page,
reject it as unreadable (`OCR_GPT_SOURCE_UNCERTAIN`), or find it invalid. The transcript is scored either way.

- `plain-first` (A): the plain prompt, plus `[?]` for a word that is genuinely unreadable. Every line is student
  text (the copied question too, like the ground truth). A `[?]` word becomes an `UNCERTAIN` segment.
- `production-trim` (C): the production Qwen prompt without the self-check paragraph, plus "one segment per line"
  and "a copied question is student writing"; production schema.
- `lean-json` (D): one object per line, `{text, kind: student|excluded}`, strict schema; `excluded` lines are kept
  out of the transcript.

## Gate (`gate.cjs`)

Compares saved runs only (reads each `results.csv`, no calls). Every arm needs two runs, each measured at
`--sort latency`; both candidate runs must pass every check.

```powershell
node scripts/ocr-eval/gate.cjs --baseline P1,P2 --production Q1,Q2 --candidate C1,C2 [--out file.md]
```

Checks: G1/G2 mean CER/WER at most +0.5 points over plain; G3 per photo at most +3 points (CER and WER); G4 every
page under 30 s; G5 every photo valid production evidence; G6 no more pages rejected than production, and none that
plain read below 5% CER; G7 at most +2 words deleted per photo vs plain; G8 over-correction not worse than plain
(N/A without mistakes lists); G9 one call per page and cost no higher than production. Exit 0 PASS, 1 FAIL,
2 INCOMPLETE (missing runs, wrong routing, fewer than two runs) or usage error.

Reports are rewritten after every call, so an interrupted run keeps a partial `results.csv` and `summary.md`
(marked "Partial results").

## Image variants

- `original` - exactly what production sends (the production `orientImage`: EXIF rotation only).
- `preprocessed` - auto-rotate, grayscale, 1-99 percentile contrast stretch, light sharpen (sigma 0.8), JPEG q92.
- `client-export` - approximates what the new frontend crop export uploads (JPEG q92, size-fitted to 8 MB,
  long edge kept at 2000 px or more). Browser canvas scaling differs slightly from sharp.

## Metrics

- **CER / WER**, case-sensitive and case-insensitive, via edit distance over the normalised text. Whitespace and
  line breaks do not count; punctuation stays attached to its word; typographic quotes and dashes are treated as
  plain ones. Averages are per photo (every photo weighs the same); failed calls are excluded and counted.
  `results.csv` also splits the case-sensitive word errors into `substitutions`, `deletions` and `insertions`.
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

`npx jest --runInBand tests/ocrEval`
