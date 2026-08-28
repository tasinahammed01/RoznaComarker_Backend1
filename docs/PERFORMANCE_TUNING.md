# Assessment performance tuning

Validate changes in staging and compare the existing `Submission analysis timing`, `Canonical evaluation timing`, provider/model, attempt, and token metrics before production rollout.

| Variable | Current default | Recommended value | Rationale |
| --- | --- | --- | --- |
| `ASSESSMENT_AI_ATTEMPT_TIMEOUT_MS` | `30000` | Try `15000` | Fails over to the configured fallback model faster instead of waiting up to 30 seconds per attempt. |
| `ASSESSMENT_AI_PRIMARY_MODEL` | `openai/gpt-4.1` | Consider `openai/gpt-4.1-mini` | Keep `openai/gpt-4.1` as `ASSESSMENT_AI_FALLBACK_1_MODEL`; this is a genuine model-quality trade-off and must be validated against a representative batch of real gradings before production rollout. |
| `SEMANTIC_AI_MAX_OUTPUT_TOKENS` | `8000` | `3000`-`4000` only if observed usage supports it | Check real `outputTokenCount` values first; leave the current value unchanged if actual responses approach the proposed limit. |
| `SEMANTIC_AUDIT_ATTEMPT_TIMEOUT_MS` | `15000` | `15000` | Bounds the best-effort category repair pass without changing the primary analysis timeout. |
| `SEMANTIC_AUDIT_MIN_ZERO_CATEGORIES` | `1` | Leave at `1` initially; A/B test higher values | Raising the threshold reduces audit frequency and latency at the cost of some best-effort category coverage, so compare graded output on real submissions before changing it. |

These are deployment recommendations, not application defaults. Change one variable at a time and compare latency, accepted correction counts, rubric scores, timeout rates, and fallback usage against the existing logs.
