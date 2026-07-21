# Semantic analysis performance benchmark

Date: 2026-07-19

No pre-change production timing distribution existed, so an original median/p95 cannot be
reconstructed honestly. Live measurements below use the new compact request and bounded client.
No new model was selected because `SEMANTIC_AI_MODEL` and `SEMANTIC_AI_APPROVED_MODELS` are not
configured and the existing fast fallback failed its provider-availability gate.

## Proven original bottleneck

- Semantic analysis inherited `PRIMARY_AI_MODEL=openai/gpt-oss-120b`.
- Each OpenRouter attempt could run for 60,000 ms.
- The general client allowed three attempts and two one-second delays.
- Calculated worst case: 182,000 ms before JSON parsing, validation, evaluation, and feedback.
- The semantic request allowed 4,000 output tokens.
- There was no overall semantic deadline and no semantic-specific model selection.
- The prompt serialized full semantic legend records, full assignment input, verbose page records,
  and LanguageTool quotation text.

## Structural benchmark

Run with `npm run benchmark:semantic`.

| Fixture | Old chars | Compact chars | Reduction | Old token estimate | Compact estimate |
|---|---:|---:|---:|---:|---:|
| 150 words | 4,778 | 4,527 | 5.3% | 1,195 | 1,132 |
| 450 words | 7,427 | 7,176 | 3.4% | 1,857 | 1,794 |
| 1,000 words | 12,293 | 12,041 | 2.0% | 3,074 | 3,011 |
| Two pages / 450 words | 7,502 | 7,246 | 3.4% | 1,876 | 1,812 |
| Ten pages / 1,000 words | 12,981 | 12,677 | 2.3% | 3,246 | 3,170 |

The transcript dominates larger requests, so prompt reduction is deliberately modest rather than
truncating student text or rubric evidence. The semantic output cap falls from 4,000 to 2,400 tokens
(40%) while retaining the existing maximum of 40 corrections.

## Retry budget

| Contract | Before | After |
|---|---:|---:|
| Attempt timeout | 60,000 ms | 45,000 ms |
| Maximum attempts | 3 | 2 (one retry) |
| Overall deadline | None | 90,000 ms |
| Calculated worst case | 182,000 ms | 90,000 ms hard maximum |

Retries use new abort signals, honor `Retry-After` only when it fits, and do not begin when the
remaining deadline is below the minimum useful attempt budget. Authentication, model, invalid
request, and invalid provider-response failures are not retried.

## Quality gate

Fourteen sanitized labeled fixtures cover conclusion, development, relevance, supporting details,
cohesion, paragraph unity, repetition, word choice/form, collocation, legitimate zero findings,
grammar-only writing, multi-page writing, and repeated quotations.

Suggested acceptance thresholds for approving a candidate model:

- Valid JSON and transcript-hash rate: at least 99%.
- Fabricated/invalid quotation rate: 0% after canonical validation.
- Invalid category/symbol rate: below 1%.
- Duplicate rate after canonical merge: below 2%.
- Expected-symbol recall: no more than five percentage points below the current model.
- Expected-symbol precision: no more than five percentage points below the current model.
- Legitimate-zero fixtures must not gain fabricated semantic findings.
- Median latency target: below 30 seconds for 300–600 words.
- p95 target: below 75 seconds.

Run live benchmarking only after explicitly approving candidates:

```text
SEMANTIC_AI_APPROVED_MODELS=model/a,model/b
SEMANTIC_BENCHMARK_MODELS=model/a,model/b
npm run benchmark:semantic -- --live
```

The live command is intentionally excluded from normal CI and reports model-level median/p95,
valid JSON/hash rate, precision/recall, raw and accepted correction counts, invalid evidence, and
duplicates.

## Live sanitized benchmark

Two sequential passes were run. The first mixed/cold pass measured the current model at 13.3 s
median and 41.0 s p95 with 78.6% valid JSON/hash responses. A focused warm rerun completed all 14
fixtures and measured:

| Provider/model | Median | p95 | Valid JSON/hash | Symbol recall | Symbol precision | Invalid evidence | Duplicates |
|---|---:|---:|---:|---:|---:|---:|---:|
| OpenRouter `openai/gpt-oss-120b` | 10.6 s | 26.3 s | 100% | 83.3% | 50.0% | 0 | 0 |
| OpenAI `gpt-4o-mini` | 2.6 s rejection | 3.1 s rejection | 0% | 0% | 0% | 0 | 0 |

Every `gpt-4o-mini` request returned HTTP 429. Its timing is rejection latency, not completion
latency, so it is not approved or selected. The 120B model remains the effective semantic model.
The labeled fixtures are conservative; symbol precision reports findings outside those narrow
labels, while the separate evidence validator confirmed zero fabricated/invalid quotations among
30 accepted corrections.
