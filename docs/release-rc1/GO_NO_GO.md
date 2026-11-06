# Go / No-go: Release Candidate 3

This is the decision sheet, not a record of results. RC3 is RC2 plus the Gemini reader and the line-by-line word boxes. The test and boot rehearsal results are in the verification report of the task that produced them, and must be read before deciding.

## Conditions to NOT ship

- The production commit is not known (DEPLOY_RUNBOOK step 0).
- `origin/release-candidate-3` on GitHub is not the final RC3 commit (the push-status check made after Task 22 found it 8 commits behind, and `origin/highlight-sync` 14 behind).
- The `.env` was switched to Gemini before the new code was merged: the old code will not start with it.
- The check in DEPLOY_RUNBOOK step 1 reports any fatal problem, for example `AI_PRIMARY_PROVIDER`, `AI_PRIMARY_MODEL`, `OPENROUTER_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, `PAYMENT_PROVIDER` not `paypal`, a missing `OCR_SOURCE_MODE` or `OCR_GPT_VISION_MODEL`, or a model and reader that do not belong together (Gemini needs `verbatim_json`; Qwen needs `json_contract` or `plain_text`): the server will not start.
- `.env` has a duplicate key the check lists: the last occurrence wins, which may not be the value you meant.
- The flashcard indexes (DEPLOY_RUNBOOK step 4) are missing or different and have not been migrated: the server will not start.
- The two guest indexes (step 4) are missing or different and guest submission must work: uploads answer 503.
- An `AI_FALLBACK_n_MODEL` on `openrouter` has no provider prefix: the server starts, and that fallback fails when needed.
- `HEALTH_DETAIL_TOKEN` is not set: the deploy cannot be verified.
- No Atlas snapshot was taken.
- The manual checklist finds a teacher or student flow broken, in particular highlights on the source image.
- The new backend fails to boot against the real Atlas.
- The client has not been told about the known issues in KNOWN_RISKS.md numbers 1 to 3, and the transcription limits in numbers 17 to 22.

## The fidelity gate, as measured

Twelve handwriting samples, on the final code. Dropped lines: 0 (pass). Word boxes: at least 91.1% per sample (pass). Differences between runs: 0 (pass). **Silently corrected words: overall 3.3%, but above the 3% limit on 5 of 12 samples, worst 15.7%, and most of those are capital letters (fail).** Shipping means accepting this limit; KNOWN_RISKS number 17 says what a teacher sees. The alternative is the Qwen reader, on the same code, by the env change in DEPLOY_RUNBOOK step 7. Qwen was not measured on these samples.

## Content and Organization findings, as measured

The detector rarely returns Content or Organization findings (0 on most of 11 samples, also on samples that lost marks in these categories). A rewritten detector prompt was tried and dropped: it did not produce them where marks were lost, its run-to-run difference reached 26%, and 3 of 25 calls failed. So teachers and students see a count of 0 for these two categories on many essays, while the rubric score in the score panel shows the marks lost. This is a known limit, KNOWN_RISKS number 23.

## Verification status after Task 22

The final freeze was NOT fully run after Task 22. What was run: the related backend suites (97 of 97 pass, including the student payload guard, the PDF parity guard and the golden file), frontend Karma for the changed areas (725 of 725 pass) and a successful production build. Not run, and to be done at deploy time: the full backend suite compared name by name with `origin/main`, the production-mode startup rehearsal with `verify:runtime`, and the production build in a temporary worktree with the secret and "Holistic" scans.

## Tasks 20 to 22, as measured

Correction failures with the real model: 30 of 90 runs before, 0 of 90 after (3 essays x 30). Word-level underlines on every development-database page: 0 of 860 changed by the grouped brackets. Browser checks (in-memory copies, built frontend): 48 annotation views at 360 to 1440px, and 31 checks on the card buttons and on a second draft with failed corrections; the correction retry ran with a patched provider, not the real one.

## Not proven by any automated check

A real browser, a real device (iPad Safari, touch), real AI providers, real email delivery, real PayPal calls, real Firebase sign-in, the VPS and the real Atlas (data volume, timings, MongoDB version). Task 22's check of a fresh second draft as a registered student on the development database was not run (it needs a real sign-in); the same flow was checked on an in-memory copy.
