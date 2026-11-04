# Go / No-go: Release Candidate 2

This is the decision sheet, not a record of results. RC1's rehearsal evidence does not carry over: RC1 contained the OCR reader work and RC2 does not. The test and boot rehearsal results for RC2 are in the verification report of the task that produced them, and must be read before deciding.

## Conditions to NOT ship

- The production commit is not known (DEPLOY_RUNBOOK step 0).
- The check in DEPLOY_RUNBOOK step 1 reports any fatal problem, for example `AI_PRIMARY_PROVIDER`, `AI_PRIMARY_MODEL`, `OPENROUTER_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, `PAYMENT_PROVIDER` not `paypal`, or `OCR_GPT_VISION_MODEL` selecting Gemini: the server will not start.
- The flashcard indexes (DEPLOY_RUNBOOK step 4) are missing or different and have not been migrated: the server will not start.
- The two guest indexes (step 4) are missing or different and guest submission must work: uploads answer 503.
- `OCR_SOURCE_MODE` or `OCR_GPT_VISION_MODEL` is missing and that was not intended: the server starts on a default reader or model, and the production log does not show it.
- `HEALTH_DETAIL_TOKEN` is not set: the deploy cannot be verified.
- No Atlas snapshot was taken.
- The manual checklist finds a teacher or student flow broken, in particular highlights on the source image.
- The new backend fails to boot against the real Atlas.
- The client has not been told about the known issues in KNOWN_RISKS.md numbers 1 to 3.

## Not proven by any automated check

A real browser, a real device (iPad Safari, touch), real AI providers, real email delivery, real PayPal calls, real Firebase sign-in, the VPS and the real Atlas (data volume, timings, MongoDB version).
