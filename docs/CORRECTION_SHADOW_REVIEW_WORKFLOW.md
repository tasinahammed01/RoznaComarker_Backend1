# Private staging correction review workflow

This is preparation only. No production upload/OCR/controller route invokes the new path. The normal production route and model remain unchanged. `CORRECTION_PIPELINE_MODE=legacy` is the default. `shadow_v15` is honored only with `NODE_ENV=staging`, and still requires explicit internal adapters and a current page snapshot. There is no default generator or verifier connection.

Before a real staging attempt, an authorized developer must supply an existing completed OCR page snapshot (current submission/file/page/run plus image/input hashes), private storage repository and current-job check. Invoke `scheduleAfterUpload` only after the normal upload/OCR completion; never await its completion in the student response. It uses detached bounded tasks, two active work slots and a 45-second ceiling. Adapters must honor AbortSignal; late analysis cannot write a completed artifact. The optional private `CorrectionShadowReview` collection has a hidden payload and 30-day TTL, using the same internal-only pattern as HybridOcrEvidence. No public/student route, score writer, PDF publisher or marker publisher is provided.

The offline replay is:

```powershell
cd backend
node scripts/replayCorrectionShadowOffline.js
```

It intentionally uses an exclusive new artifact directory and refuses to overwrite existing outputs. Existing completed replay artifacts can be inspected directly; do not reset old benchmark directories or run real providers to reproduce them.

Review artifacts live only under `backend/tests/fixtures/hybrid-source/private/`, which is ignored and never served publicly. Open the local `review.html` to inspect the image, exact source, proposed changes and diagnostic operative geometry. The geometry is not an authoritative student marker. The HTML has no script, remote assets or form endpoint. Treat student content as private; distribute only inside the existing authorized developer/reviewer storage boundary.

To record a semantic review:

1. Explicitly register the authenticated internal reviewer ID in a private registry file. Both HUMAN_REVIEWER and INDEPENDENT_AI_VERIFIER require `independentOf` containing the generator ID. An AI verifier with the same configured model as the generator is rejected even under a different reviewer ID.
2. Independently inspect ONE candidate's exact image/source/context/edit/code. Edit its companion action: set action=RECORD_HUMAN_SEMANTIC_REVIEW, confirmed=true, reviewerId, unique reviewId, candidateKey, decision (SUPPORTED/UNSUPPORTED/UNCERTAIN) and a brief rationale. No template defaults to approval.
3. Create a receipt with the offline tool, using paths under the private root:

```powershell
node scripts/reviewCorrectionShadowOffline.js receipt <candidate-request.json> <trusted-registry.json> <explicit-action.json> <new-receipt.json>
```

4. Supply approved receipts explicitly to a subsequent private shadow analysis. Raw model output, evaluator matching and test fixtures never create human receipts. Stale/foreign receipts are rejected; conflicting UNSUPPORTED/UNCERTAIN blocks authority. Receipts may be retained in private review artifacts; no receipt alters a student result.

For future 10–20 reviewed pages, create one private directory per page/run, keeping image and source identity distinct. `goldWorkflow.draft(artifact)` produces UNREVIEWED source/correction templates, never gold. Review the original image and manually correct the active transcript without linguistic normalization; document excluded prompts/crossouts/branding. Independently author the exhaustive correction list and negative controls in the existing human-gold-v1 / human-corrections-v1 schema. Do not copy generated findings as human approval. Geometry not independently proven must remain MAPPING_WITHHELD.

Create an explicit FINALIZE_HUMAN_GOLD action with reviewerId, confirmedActiveTranscript=true, confirmedExhaustiveCorrections=true, confirmedNegativeControls=true and draftSha256 equal to SHA-256 of JSON.stringify(the edited draft). This attests to the entire frozen content. Then:

```powershell
node scripts/reviewCorrectionShadowOffline.js freeze-gold <edited-draft.json> <trusted-registry.json> <explicit-completion.json> <new-page-directory/freeze-audit.json>
```

The tool validates and creates separate human-gold.json, human-corrections.json and negative-controls.json without overwriting anything. Exact reviewed geometry requires the programmatic workflow's explicit geometry proof; the simple CLI conservatively supports withheld mappings. Preserve image SHA, file/page/run identity and source hash with the frozen files.

`metrics.evaluate(pages)` excludes pages without reviewed active source AND exhaustive reviewed correction gold. It reuses strict/operative metrics; semantic-review rates distinguish pending from rejected/uncertain, and authority precision has a null denominator when no semantic authority exists. OCR-induced false corrections require explicit registered-human causal adjudication, never transcript comparison heuristics. One reviewed page does not establish population accuracy.

A future AI verifier must be separately authorized and injected through the bounded request/response adapter. There is no live verifier in this phase. Before enabling real staging capture, confirm reviewer governance, private storage access/retention, current-run ownership, transport budget/cancellation, and an explicit staging-only post-completion caller. Authoritative scoring/publication remains unavailable.
