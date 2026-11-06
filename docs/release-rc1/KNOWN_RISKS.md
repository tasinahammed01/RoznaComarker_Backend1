# Known issues and risks for RC3, ranked

## Known issues in the product

| # | Issue | Evidence | Recommendation |
|---|---|---|---|
| 1 | **Worksheet answers reach students before they submit.** `GET /api/worksheets/:id` removes `answerKey` and `modelAnswer` but keeps `activities[].data.questions[].correctAnswer`. A student can read them with the browser's developer tools. | `worksheet.controller.js` handler; `worksheet-viewer.ts` reads the field for its client-side check, so removing it means changing the viewer. | Tell the client. Fix in a later release; it needs a server-side check. |
| 2 | **Practice explanations are sent before an attempt.** `questions[].explanation` is in the response before the student answers; no student page reads it. Whether the text gives the answer away was not checked on real data. | `assignmentAccessPolicy.service.js` `sanitizeAdaptiveSession` removes the answer fields but not this one. | Tell the client. Small later fix. |
| 3 | **Dialogs lose typed text when the width crosses 1024px.** Create or edit class (shown by a test), and by the same code pattern create or edit assignment, invite students and rubric designer (not run). The desktop dialog and the mobile sheet use different components and flags, so the dialog closes. A rotated tablet or pinch zoom may trigger it (not run). Pages themselves no longer lose text. | `my-classes-pages.html`, `detail-my-classes-pages.html`; `device.service.ts`. | Tell the client. Later release: one dialog component. |
| 4 | **A correction hidden on one draft comes back on the next.** Teacher decisions apply only to the draft they were made on, so if the AI (or a same-file resubmit) produces the same correction, the student sees it on the new draft. | `studentCorrectionView.service.js` `activeEntries`. Whether this is the intended behaviour has not been decided. | Client decision. |
| 5 | **`/api/subscription/me` 500: cause unknown.** Its `catch` logs nothing, so server logs only show the access line. RC2 does not change this path. The 500 seen in tests came from the missing `PAYMENT_PROVIDER` in the test environment (with it set, the test gets 200) and cannot happen in production, where startup requires it. Whether production really returns 500 is not confirmed. | `subscription.controller.js` `getMySubscription`. Candidates from reading the code: no active Free plan, `referralSummary`, `calculateOwnedStorageUsage`, `user.save` validation. | Check the access log and the plans collection. Add one log line later. |
| 6 | **Old classes without `isActive`.** Draft comparison treats a missing value as active, but other queries use `isActive: true` and would not match such a class: `studentProgress`, `teacherAnnotation.controller`, `feedback.controller`, `assignment.controller`, `classLifecycle.service`, `user.controller`, `submission.controller`, `imagePreflight.middleware`. | `git grep "isActive: true"`. The schema defaults to true, so this matters only if such documents exist. | Count them before the deploy: `db.classes.countDocuments({isActive:{$exists:false}})`. |
| 7 | **Unused fields still sent to the owning student:** `rawTranscriptText`, `rawOcrText`, `rawCombinedOcrText`, `sourceTranscriptExact`, `sourceFidelity*`, and legacy feedback fields. The student's own text and source state, nothing of anyone else. `words[]` and `renderTarget` contents are not allowlisted. | Listed with reasons in `tests/studentSchemaNoLeak.test.js`. | Backlog. |
| 8 | **`ocr-corrections` early return.** The `sourceFidelity && !assessmentAllowed` branch answers without the student sanitizer. It sends no corrections. Not exercised, because that source mode was not switched on in the tests. | `submission.controller.js`. | Backlog. |

## Risks of the deploy

| # | Risk | Recommendation |
|---|---|---|
| 9 | Fixed in RC3 for the reader: a missing `OCR_SOURCE_MODE` or `OCR_GPT_VISION_MODEL` stops startup. The production log still does not show which reader is active. On a rollback to RC2 the old silent default returns. | Verify from `.env` with the check in DEPLOY_RUNBOOK step 1. |
| 10 | Rolling the backend back to `45e49aae` re-shows corrections the teacher hid. | Owner's decision; tell teachers if a rollback is ever needed. |
| 11 | Nothing was run against a real production dump, real Firebase sign-in, real SMTP, iPad Safari, a real browser for RC2, or a real AI provider. | Do MANUAL_QA_CHECKLIST.md right after the deploy on a test account. |
| 12 | `node_modules` is tracked in the backend repo although `.gitignore` lists it, and the frontend has no lockfile, so `npm audit` cannot run there and an install on the server can bring other versions. | No `npm` on the VPS for the backend; build the frontend locally. Backlog. |
| 13 | From RC1, not re-measured on RC2: `npm audit --omit=dev` found 44 vulnerabilities (25 high, 2 critical: `proxy-addr`, `tar`); 300-correction essays take about 2.5-3.2 s; student corrections with a teacher decision +53% (35.8 vs 23.4 ms median); the `StudentFlashcardProgress` partial index is not supported on MongoDB 6.0. | Check the Atlas version (`db.version()`). Backlog for the rest. |
| 14 | Old frontend tab against the new backend shows "Student" as the teacher's name until refreshed (seen on RC1). | Ship. |
| 15 | The production database's indexes are not known. Missing flashcard indexes stop the server; missing guest indexes make guest upload answer 503. Rebuilding an old non-partial student index needs the app stopped. | FIX FIRST: compare with DEPLOY_RUNBOOK step 4. |
| 16 | `.env.example` misleads in two places: it lists `GOOGLE_CLOUD_KEY_FILE` but not the required `GOOGLE_APPLICATION_CREDENTIALS`, and it lists `PAYPAL_*_ANNUAL_PLAN_ID`, which the code ignores (it reads `PAYPAL_*_YEARLY_PLAN_ID`). Both are the same on `origin/main`. | Rely on the step 1 check. Backlog: correct `.env.example`. |

## Known limits of transcription and marking in RC3

| # | Limit | Evidence | Recommendation |
|---|---|---|---|
| 17 | **The reader sometimes fixes what the student wrote.** About 3% of words overall, mostly capital letters; per page it reached 15.7% on one sample and 6.3% on another. A fixed error is not marked, so the score can be slightly too high. | 12 samples, 50 of 1517 words. Some are real word changes, not only capitals. | Tell teachers: check capitalisation on the page image. |
| 18 | **`[?]` in the transcript.** The reader writes it for a word it cannot read at all. It shows as plain text to the teacher, student and guest and in the PDF, and counts as one word. A finding on that word alone, or a short one that includes it, is removed and never counts as an error. A sentence or whole-piece finding that contains it stays. The rubric model also sees the mark, unexplained; its effect on Content and Organization was not measured. A student who really writes `[?]` gets the same treatment. | `tests/unreadableWordPlaceholder.test.js`. Reader outputs in the final tally (image4, image7, image12) had none, so it has not been seen on a real page in that run. | Tell teachers what it means. |
| 19 | **The number of corrections varies between runs.** With temperature 0 and a seed, the same text still gave 14/16/16 and 21/24/24. The rubric call has no temperature or seed. A resubmitted page can get a slightly different score. | Task 15 control runs. | Tell teachers. Do not compare single points. |
| 20 | **Fixed (Task 18): a result no longer stays on the provisional page.** The page kept the provisional score and "out of date" when it read the result in the moment between the provisional and the final save; it now waits for the final result. On a real submission that moment lasted about 2 seconds. | `canonicalResultState` tests; real guest submission without reload. | None. |
| 21 | **Highlights do not cover every correction.** A word error with no word box is not drawn on the image; the page says how many, and the row says "Not located on image". Boxes matched at least 91.1% per sample. A sentence-level correction with no box gets a bracket only on lines the boxes prove. | Task 15 tally and browser checks. | Ship. The transcript view shows them all. |
| 22 | **A possible missed line is a warning to the teacher only,** inside the review panel, seen once the panel is opened. A line is not recovered automatically. | `possibleMissedLines`; never in student, guest or PDF payloads. | Tell teachers to compare with the image when they see it. |

| 23 | **Content and Organization findings are rare.** The detector returned none on most samples, also where the rubric took marks. The statistics then show 0, while the rubric score in the score panel shows the marks lost, and the feedback card shows the rubric's quoted evidence as a "Rubric note". A stronger detector prompt was tried and did not pass its gate. | Task 17 measurements, 11 samples. | Tell teachers. A later release can work on the detector. |
| 24 | **The rubric no longer sees Content or Organization findings.** This keeps their scores independent of the findings. Measured on 3 samples × 3 runs: totals stayed within the usual run-to-run range. | Task 17. | Ship. |

| 25 | **A chip can sit above the wrong line when a word's box is wrong.** Seen once (an ART chip): the word's box itself was placed on another line by the geometry's third pass; the chip follows its box. | Task 17 fresh submission. | Ship; the row and the transcript are right. |
| 26 | **Adaptive practice is not offered when the final evaluation is an AI partial result.** Practice requires a completed evaluation that matches the corrections; a partial one keeps the studio on "unavailable". | Task 18 audit, server gate unchanged. | Later release, if wanted. |

Summary of the limits to tell the client: Content and Organization detection is conservative (number 23; the detector prompt change was dropped by its gate); capital letters are silently corrected in about 3% of words (17); correction counts vary slightly between runs (19); highlight coverage depends on the word boxes (21, 25); dialog text loss on resize (3); worksheet answer visibility (1); no practice on an AI partial evaluation (26).

Worksheet answer visibility is number 1 above and dialog text loss on resize is number 3: both still apply.

## Added by Tasks 20 to 22

| # | Issue or risk | Recommendation |
|---|---|---|
| 24 | **A teacher's full "Regenerate" uses a second Assessment Credit** after a result whose correction step failed (it re-scores; the credit is per assessment run). The free "Retry corrections" button is the intended action for that case and is offered first. Verified by `tests/correctionRetryCredit.test.js`. | Tell teachers: use "Retry corrections", not "Regenerate", when only the corrections are missing. |
| 25 | **A score made before the corrections stays as it was.** When corrections arrive by a retry, the score is not recomputed (by design, scores never change on their own); the score card says so in one line. Counts can then differ from a rubric category (for example Grammar full marks with 1 grammar correction). | Teacher decision per case; a full Regenerate (one credit) re-scores. |
| 26 | **The automatic correction retry is held in memory.** If the server restarts during the 10-second wait or the retry, the page shows "still being prepared" for at most 10 minutes, then offers the manual retry. Nothing is lost and nothing is re-scored. | Ship. |
| 27 | **Some word-level chips moved slightly** on pages with sentence-level corrections: on the development database 161 of 1,399 chip placements (desktop and phone counted separately) differ, almost all because a sentence-level chip no longer shares or crowds the word's chip. Underlines themselves: 0 changed. | Ship. |
| 28 | **An overdue assignment never submitted shows "View Submission"** on the student's class page (it leads to an empty result). It no longer shows "Submit Another Draft". The button logic was left as it was. | Backlog: show "Upload Essay" or a closed state. |
| 29 | **Line endings and the PDF parity guard.** The generated PDF rules carry hashes of the website source files as they were on disk; with `core.autocrlf=true` on Windows a fresh checkout can fail `pdfWebsiteAnnotationConsistency` although the code is identical. Linux checkouts (the VPS) are not affected. Pre-existing. | Backlog: a `.gitattributes` with `eol=lf` for the rule sources. |

## Test suites that fail, also on `origin/main`

They are not regressions, but they are not all understood.

| Suite | Finding |
|---|---|
| `institutionCredit` | **Explained (Task 22): a stale test, not a money defect.** The test fixes the wallet cycle at 2026-09-01 to 2026-10-01. Since today is past the cycle end, the first debit correctly rolls the wallet into a new month (`monthlyCreditsUsed` 0, then 1) and leaves the carried top-up credits untouched, which is the intended rule (monthly allowance first). It started failing when the clock passed 2026-10-01, on `origin/main` too. Fix later: relative dates in the test. |
| `classArchive`, `subscription.usage` | `POST /api/classes` answers 500 at `buildJoinUrl` because `FRONTEND_URL` is missing in the test environment. Production requires it at startup. Not re-run with it set. |
| `phase2AssignmentControls` | With `PAYMENT_PROVIDER` set, the remaining failures answer 409 "still being processed", the guard against a second upload during processing. The test predates it. |
| `provisionalGuestPersistence` | The test sends `PROMPT_VERSION`; the code requires the Gemini prompt version since the default model changed. |
| `assignmentDuplicate` | `submitted` expected 1, received 0; the test has no membership. Cause not confirmed. |
| Others | Stale model defaults, missing `.gitignore`d fixtures, paths outside the repo. See the verification reports. |

Time-dependent tests: `recoveryPortal` fails when it runs across the top of an hour. `teacherRecoveryLink` no longer does (RC3 test fix). Under load, in-memory Mongo may miss its 10 s start, `submissionFeedbackPdfAssets` its 30 s limit, and `adaptivePractice`, `identicalReupload.release` and `annotationGolden` have failed once and passed on rerun.
