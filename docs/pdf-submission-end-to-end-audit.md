# COMARKER PDF SUBMISSION END-TO-END AUDIT

## 1. Executive Summary

Implemented ordered, private PDF page assets shared by OCR, student review, teacher review, and generated feedback reports. Fresh 1-, 2-, and 5-page submissions completed through the normal submission API and real configured OCR/assessment providers. A separate two-page scanned sample produced four corrections on each page. No historical submissions were reprocessed.

## 2. Client Failure Reproduction

The configured database contained no PDF File records. The client's source PDF and failure-state record remain unavailable. Therefore the exact client incident is unverified. The user explicitly authorized disposable PDFs for the generic audit.

Locally, a valid disposable PDF using standard Helvetica produced completely white OCR input with the old rasterizer: RGB minimum/maximum 255, standard deviation 0. PDF.js reported missing LiberationSans and unresolved Helvetica paths. After configuring font assets, the same source rendered text (minimum 0, standard deviation 12.11). This proves a local source-PDF rendering defect, not the cause of every possible client failure.

Fresh uploads returned HTTP 200; OCR, corrections, semantic assessment, evaluation, and assessment reached completed states; generated feedback downloads returned 200.

## 3. Exact Root Cause

The server PDF.js renderer lacked standard-font and CMap asset paths. Valid PDFs relying on standard fonts could render blank before OCR. Additional proven architectural defects were discarded OCR rasters, whole-document text copied into every page, dropped page dimensions, and a PDF-only review card with no shared image overlay.

## 4. Previous PDF Architecture

Source PDF → report rasterizer at scale 1.6 (115.2 DPI) → transient page buffers → OCR. Buffers were discarded, report generation rasterized again, and review opened the original PDF. The page records could contain repeated combined text.

## 5. New PDF Architecture

Private original PDF → bounded worker at 200 DPI → deterministic private JPEG assets and metadata → those exact bytes sent to OCR → page-local canonical text/word IDs → existing correction and assessment pipeline → shared page review overlay. Generated reports reuse persisted rasters when available; historical records retain the legacy fallback.

## 6. Rasterization

Uses installed pdfjs-dist 3.11.174 and canvas, with local standardFontDataUrl/cMapUrl and evaluation disabled. Maximum 20 pages per submission, 12,000 pixels per dimension, and 20 million pixels per page; configured lower PDF page limits remain effective. Default input limit is 10 MiB/file. Existing aggregate upload limit is 50 MiB/20 files.

One raster worker per application process; 90-second active deadline and 120-second queue deadline. Worker V8 heap limit is 256 MiB; this does not cap native canvas allocations. Two file tasks and two Vision calls may run concurrently; PDF pages are OCRed serially. PDF Vision calls have a 30-second maximum and no hidden provider retries; Vision queue waiting is bounded at 30 seconds. PM2 replicas multiply per-process limits.

## 7. Derived Page Assets

Uses existing File records and uploads/submissions storage. Assets record source file/hash, page count/number, dimensions, raster SHA-256, and version pdf-200dpi-v1. Cache reads verify page order, count, and bytes. Deterministic IDs/upserts and atomic file writes support retry reuse. Submission deletion removes derived records/files. Recovery removes expired temporary siblings for the affected asset. Derived images are processing artifacts and do not double-charge original upload storage.

## 8. OCR

Live typed samples attempted and completed 1/1, 2/2, and 5/5 pages; two scanned samples completed 2/2 each. Page order and page-local text are preserved. Partial PDF OCR failure prevents assessment from accepting an incomplete document. PDF errors have safe user-facing messages.

## 9. Canonical Transcript

The existing transcript builder receives each page's own text, words, dimensions, and source identity. Word IDs remain scoped by file/page/word. No duplicate transcript or scoring pipeline was introduced.

## 10. Correction Mapping

The existing canonical target resolution and annotation geometry are retained. Source file/page IDs select the matching OCR words and corrections. No correction data was manually seeded in the live provider run.

## 11. Page Scoping

The active image, word list, annotation list, and page number change together. The distinct two-page sample has disjoint correction-ID sets: four on page 1 and four on page 2. No page leakage was observed.

## 12. Assessment / Scoring

All live samples used the existing assessment pipeline. The distinct scanned sample generated eight corrections and a completed evaluation. No scoring formula or deduction rules were changed.

## 13. Credit Idempotency

The distinct live sample had one assessment debit before replay and one after replay. Existing credit, recovery, completion, and resubmission regressions passed. No payment, entitlement, promo, or production credit records were modified by this audit.

## 14. Student Review

The PDF branch now renders SubmissionPageReview using the existing CorrectionOverlay. Authenticated HttpClient fetches private image blobs; requests are cancelled and object URLs revoked on page changes/destruction. Parent-template tests exercise the integration.

## 15. Teacher Review

Uses the same page-review component and overlay. Student and owning teacher received 200 for the same page assets. The browser visual harness mounts this real shared component using captured live API data; its role headings are wrappers, not screenshots of fully authenticated routed dashboards.

## 16. Original PDF Access

Open Original PDF remains a secondary action using the existing private source-file access path.

## 17. Multi-Page Navigation

Previous/Next controls and Page X of N select one page at a time. Boundary controls disable appropriately. Loading/failure states and image retry are supported. Only server-owned private JPG routes are accepted by the shared component.

## 18. Annotation Consistency

Page 1: four corrections, labels DEV/AGR/CL/AGR. Page 2: four corrections, labels DEV/T/DEV/T. Student/teacher desktop renderings and all mobile widths used the same canonical IDs. Ten browser captures had zero badge collisions and zero out-of-bounds badges for this sample.

## 19. OCR Raster vs Display Raster

Both pages measured 1653 × 2339. OCR and served-image SHA-256 matched exactly:

- Page 1: b5caf2a025f75715ea9235d2d9d346ad5b65ed1c4cc4e09a2aa0192fcb75a028
- Page 2: b0f27fa3bdc76d1ae181cabc1c964aa31988245cc8b3227e1bf8bf48d9b3191a

Evidence: workspace output/pdf-submission-audit/distinct/live-results.json.

## 20. Mobile QA

| Width | Badge | Text | Effective tap area | Collisions / outside |
| --- | --- | --- | --- | --- |
| 430 | 20 px | 8 px | 40 × 40 px | 0 / 0 |
| 390 | 19 px | 7.5 px | 40 × 40 px | 0 / 0 |
| 375 | 19 px | 7.5 px | 40 × 40 px | 0 / 0 |

Chrome subpixel measurement was 39.99 px horizontally for the smaller badges. Real clicks four pixels outside each visible first badge opened the correction dialog on both pages at all three widths. Desktop sizing and annotation layout rules were not changed. Evidence: distinct/browser/tap-metrics.json and screenshots.

## 21. Generated Feedback PDF Regression

All live source fixtures returned downloadable feedback PDFs. All six pages of the distinct sample's feedback PDF were rasterized and visually inspected: score summary, both annotated source pages, transcripts, correction notes, and detailed feedback were readable without clipping. Existing report/hidden-mark HTTP regressions passed.

Inspection found deterministic revision reasons embedded numeric marks in prose. New reasons omit those marks; hidden-mark responses also strip the exact older generated phrase without modifying stored records or unrelated written comments. This is a narrow fix, not general natural-language score redaction. The captured marks-visible live PDF predates this wording-only fix; focused HTTP/unit checks cover the final code.

## 22. Failure / Retry / Restart Behavior

Tests cover corrupt, password-protected, oversized, excessive-page and dangerous-dimension input, partial OCR failure, obsolete job ownership, worker crash, active timeout, queue expiry, cache reuse, and deletion cleanup. Job ownership includes lease ownership to prevent stale workers writing after replacement. Existing recovery/lease tests passed. A physical PM2 kill/restart during OCR was not performed; this remains controlled-QA work. Default recovery lease is 30 minutes with three attempts; the UI's five-minute observation timeout does not cancel the backend job.

## 23. Security

Private assets require authorization; owner/teacher 200, unrelated account 403, unauthenticated 401 were tested. Responses remain private/no-store with nosniff. Safe asset filenames, local font assets, image hash checks, and route-only browser fetching avoid arbitrary external asset fetches. Logs/artifacts use disposable data; credentials are not included in this report. Real providers received only disposable documents. No production mutation or public asset publication occurred.

## 24. Performance

Observed upload-to-assessment durations: one typed page 16.384 s, two typed pages 36.838 s, five typed pages 24.252 s. Provider variation means these are samples, not a throughput benchmark.

Distinct two-page scan: 182,823 bytes; total 24.442 s; raster/persistence 5.082 s; Vision 1.030 + 0.683 = 1.713 s. Remaining elapsed time includes assessment, scheduling, and polling. Image cache avoids rerasterization on ordinary retries/reports. Server capacity and multiple PM2 workers need load testing; persistent derived assets add disk use despite exclusion from upload quotas.

## 25. Database Changes

Added optional source/derived-page metadata to File and Submission. No data migration required. Historical records changed: none. No automatic backfill/reassessment. Disposable QA used isolated Mongo databases, test users, and generated PDFs; cleanup removes its files. Explicit historical reprocessing, if later requested, must use the existing controlled retry/reassessment path and current credit policy.

## 26. Tests

Backend: initial broad run 231/233 passed; two outdated fixtures were corrected and their focused rerun passed 19/19. Subsequent six-suite PDF regression passed 32/32. Final six-suite edge regression passed 23/23, including queue expiry, private assets, storage accounting, hidden marks, detailed feedback, and feedback HTTP. An older access-policy expectation that retained maxScore was updated to the established hidden-mark contract. No known unresolved test failure. Counts overlap and must not be summed as unique tests.

Frontend: broad affected regression 216/216 passed; final parent/shared-component regression 80/80 passed. Browser visual and tap checks passed at all required widths. Tests cover normal overlays and layout behavior as well as PDF page navigation.

Reproduce the real-provider sample from backend with `node scripts/qaPdfSubmission.js --live`. This explicitly uses configured OCR/AI credentials and incurs provider requests, but uses disposable local database records. Output goes to output/pdf-submission-audit/replay. Test logs reside under workspace tmp/pdf-*.log.

## 27. Build

Frontend TypeScript: passed. Production build: passed with existing CommonJS/CSS warnings. Changed-file lint comparison: zero additional diagnostics against HEAD; repository-wide lint cleanliness is not claimed. Backend changed JavaScript syntax and both repository diff checks: passed. Chrome test shutdown warnings occurred after passing tests.

## 28. Remaining Risks

- Exact client PDF/record remains unavailable, so the original incident is not conclusively attributed.
- Real PM2 restart, concurrent load, disk exhaustion, and multi-instance storage are not end-to-end verified.
- Visual screenshots mount the real shared component with live captured data; complete authenticated student/teacher route navigation needs controlled QA.
- Arbitrary scanned layouts, rotations, dense handwriting, and provider recognition quality require broader documents. Passing sample collision checks do not prove every layout.
- No automatic historical migration; old submissions without page assets retain their existing fallback.

## 29. Final Verdict

READY FOR CONTROLLED QA

The generic implementation and disposable live-provider pipeline are verified. This verdict does not certify the unavailable client incident or production readiness under load.
