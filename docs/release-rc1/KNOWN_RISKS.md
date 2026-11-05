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
| 20 | **First open of a result can sit on the provisional page for about 3 seconds** before it moves on. | Audit only, not fixed. | Later release. |
| 21 | **Highlights do not cover every correction.** A word error with no word box is not drawn on the image; the page says how many, and the row says "Not located on image". Boxes matched at least 91.1% per sample. A sentence-level correction with no box gets a bracket only on lines the boxes prove. | Task 15 tally and browser checks. | Ship. The transcript view shows them all. |
| 22 | **A possible missed line is a warning to the teacher only,** inside the review panel, seen once the panel is opened. A line is not recovered automatically. | `possibleMissedLines`; never in student, guest or PDF payloads. | Tell teachers to compare with the image when they see it. |

| 23 | **Content and Organization findings are rare.** The detector returned none on most samples, also where the rubric took marks. The statistics then show 0 with the rubric score beside it, and the feedback card shows the rubric's quoted evidence as a "Rubric note". A stronger detector prompt was tried and did not pass its gate. | Task 17 measurements, 11 samples. | Tell teachers. A later release can work on the detector. |
| 24 | **The rubric no longer sees Content or Organization findings.** This keeps their scores independent of the findings. Measured on 3 samples × 3 runs: totals stayed within the usual run-to-run range. | Task 17. | Ship. |

Worksheet answer visibility is number 1 above and dialog text loss on resize is number 3: both still apply.

## Test suites that fail, also on `origin/main`

They are not regressions, but they are not all understood.

| Suite | Finding |
|---|---|
| `institutionCredit` | **Unexplained, and it is a money path.** `monthlyCreditsUsed` expected 3, received 1. Possibly the monthly cycle reset with a stale test date (not confirmed). A real bug is not ruled out. |
| `classArchive`, `subscription.usage` | `POST /api/classes` answers 500 at `buildJoinUrl` because `FRONTEND_URL` is missing in the test environment. Production requires it at startup. Not re-run with it set. |
| `phase2AssignmentControls` | With `PAYMENT_PROVIDER` set, the remaining failures answer 409 "still being processed", the guard against a second upload during processing. The test predates it. |
| `provisionalGuestPersistence` | The test sends `PROMPT_VERSION`; the code requires the Gemini prompt version since the default model changed. |
| `assignmentDuplicate` | `submitted` expected 1, received 0; the test has no membership. Cause not confirmed. |
| Others | Stale model defaults, missing `.gitignore`d fixtures, paths outside the repo. See the verification reports. |

Time-dependent tests: `recoveryPortal` fails when it runs across the top of an hour. `teacherRecoveryLink` no longer does (RC3 test fix). Under load, in-memory Mongo may miss its 10 s start, `submissionFeedbackPdfAssets` its 30 s limit, and `adaptivePractice`, `identicalReupload.release` and `annotationGolden` have failed once and passed on rerun.
