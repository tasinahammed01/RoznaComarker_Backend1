# Private handwriting benchmark

No image or gold transcript is supplied or fabricated. Golden 001 is pending.
Put the real Louise Mallard page at `private/001-louise-mallard/source.png` (or its original image extension).
Put human-reviewed `human-gold.json` and captured `candidate.json` alongside it.
The entire private directory is ignored by Git, including transcriptions and model outputs.
Use further numbered directories for 50–100 diverse real pages; do not reuse one essay as a test corpus.

Human-gold fields: `version: "human-gold-v1"`, `humanReviewed: true`, nonempty
`reviewer`, original `imageSha256`, exact active `transcript`, `excludedSpans`
(`classification`, `text`), and `expectedCorrections` (exact `start`, `end`,
`category`, `symbol`, `quotedText`, `suggestedText`). Preserve all original spelling.
Do not set humanReviewed on machine-generated text without human review.

Candidate fields: matching original `imageSha256`, `transcript`, optional `bindings`,
optional `corrections` using the same correction fields. Each correction needs a
human-reviewed boolean `humanReviewedOcrInduced` to measure OCR-induced false
correction rate. Unavailable metrics are null, never invented zeroes.

Run `node scripts/benchmarkHybridSource.js` from backend. It makes no network calls.
The correction-only harness accepts the gold transcript and an explicitly supplied
offline completion adapter through the unchanged semantic correction engine.
Live correction/provider calls require separate authorization.

Golden 001 review checklist (metadata only; never runtime rules): Mallard/Matland,
shaped/sshaped, social norms/world, the way she felt, supposed/suppossed,
realize/relize, to herself/bo herself, controlled her/controlledtion,
got rid off/got my off, body/heart, expectations/expectatione, untrue/untime, @MAXI.

Metric limits: omission/hallucination counts are edit-alignment proxies; excluded
text leakage uses literal matching and needs human adjudication when an identical
phrase legitimately appears in active writing. Line-order errors are line edit
distance, not proof of a specific physical inversion. No real accuracy claim may
be based on these tools without the private images and reviewed gold.
