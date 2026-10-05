# COMARKER WEBSITE + PDF FEEDBACK CONSISTENCY AUDIT

## 1. Executive Summary

Implemented a shared, response-only canonical target resolver for the website and PDF. Group labels communicate correction codes; static PDFs deduplicate identical target geometry while retaining every correction. Authorized students can download completed feedback with marks hidden. Qualitative feedback remains visible. No scoring, billing, OCR, or persisted correction semantics were changed.

## 2. Root Causes

- Generic group label: the website label function grouped by category and returned a generic issue count for mixed categories.
- Missing student PDF: both the student UI/download guard and backend PDF endpoint gated access on marks visibility.
- Hidden AI feedback: feedback converters required numeric scores that the API correctly redacted; detailed feedback also rendered numeric badges unconditionally.
- PDF extra underline targets: PDF rendering consumed stored evidence boxes and character offsets instead of resolving the canonical visual target. Per-correction drawing duplicated identical geometry.
- PDF transcript marker issue: the transcript rendered the first correction number rather than canonical correction codes and all applicable references.

## 3. Canonical Target Authority

`canonicalCorrectionRender.service.js` resolves valid explicit visualTarget first, legacy canonical wordIds second, and legacy bboxList last. It returns renderTarget with word IDs, anchors, boxes, transcript ranges, and transcript anchors. The OCR response and PDF view model use this helper. A valid narrow target cannot expand to its broader evidence span. Original evidence and correction IDs remain intact; the derived target is not persisted.

## 4. Interactive Website Presentation

The overlay consumes the resolved target. Existing grouping membership and placement dimensions are retained. Group selection still exposes all members. Legacy API responses retain the existing client fallback.

## 5. Static PDF Presentation

The PDF uses the same resolved target but adds static code/reference information and an index for shared targets. Punctuation insertion uses a boundary tick. Website popup behavior and PDF notes differ intentionally; target identity does not.

## 6. Grouped Error Labels

Single corrections use their canonical code. Two/three identical codes use CODE +1 / CODE +2. Mixed codes use compact combinations such as AGR·WC where they fit; dense labels use a code plus count, with the full code list available through accessible text and correction details. No group members are discarded.

## 7. PDF Static Grouping

Identical target geometry draws once. Every member remains represented in marker metadata, the shared-target index, transcript references, and separate correction notes. Geometry deduplication does not deduplicate the correction records.

## 8. Student PDF Availability

The student download action uses report readiness rather than marks visibility. The authenticated endpoint retains ownership/class authorization and private no-store delivery. Incomplete reports retain the existing safe not-ready response. Teacher access remains available.

## 9. Hidden Score Policy

Hidden student reports omit numeric totals, category scores, maximum scores, grade, score charts, numeric detailed-feedback badges, and deduction values. Correction counts are retained because they describe feedback, not grades. Teacher reports retain scores. Scoring calculations are unchanged.

## 10. AI Feedback Visibility

Fixed and custom rubric comments are extracted independently of numeric scores. Comments, evidence, transcript, strengths, areas for improvement, teacher feedback, and revision guidance remain visible. PDF action steps support legacy strings and current action/reason objects.

## 11. Website vs PDF Target Matrix

Fresh isolated submission; canonical word prefix: `word_6ac25e839632ae3963b304e7_1_`.

| Correction ID | Code | Website target | PDF target | Match |
| --- | --- | --- | --- | --- |
| ai_c8bb61756051009e | AGR | w1: was | w1: was | YES |
| ai_fc7f6cc8fb576e2a | WC | w1: was | w1: was | YES |
| ai_2bdd39b1acd71471 | P | INSERT period after w2: ready | INSERT period after w2: ready | YES |
| ai_f0a23fe99ce810a3 | SP | w5: teh | w5: teh | YES |

AGR/WC: box {x:26,y:25,w:12,h:3}, transcript [9,12). SP: box {x:42,y:45,w:12,h:3}, transcript [29,32). P: anchor at transcript offset 18. The complete compared objects are in `output/feedback-consistency/new-submission-matrix.json` at the workspace root. All four correction IDs and both representations' counts match.

## 12. PDF Transcribed Essay Types

Transcript annotations display AGR/WC, P, and SP, alongside all applicable correction-note references. Numeric references remain useful for navigation but no longer replace error types.

## 13. Correction Notes

All four corrections retain their own note, code, category, original/replacement evidence, and explanation. Broad evidence may remain in explanatory notes without becoming broad visual targeting.

## 14. Legacy Compatibility

Regression coverage includes legacy word IDs, bbox-only targets, invalid explicit target fallback, and legacy feedback strings. Stored transcript character ranges are used only for bbox-only legacy fallback when no authoritative word/visual target exists. No migration is required.

## 15. New Submission QA

Created a new isolated Mongo submission through the current canonical correction normalization pipeline, using deterministic provider input and a temporary uploaded image. Exercised authenticated OCR/PDF HTTP routes for the owning student and teacher. The HTTP test captures the actual report view model at the final PDF writer boundary; the production PDF generator then rendered that captured model into student and teacher PDFs. Both four-page PDFs were rasterized and all eight pages visually inspected. Extracted-text checks also verified score visibility and qualitative feedback.

This is fresh-submission integration QA, not a live paid AI/OCR provider assessment. Artifacts are under workspace `output/feedback-consistency/` and `output/pdf/`.

## 16. Mobile Regression

| Width | Badge height | Text | Effective tap area | Collision/out-of-bounds findings |
| --- | --- | --- | --- | --- |
| 430px | 20px | 8px | 40px CSS | 0 |
| 390px | 19px | 7.5px | 40px CSS | 0 |
| 375px | 19px | 7.5px | 40px CSS | 0 |

Recent badge CSS/TypeScript metrics, padding, and desktop/tablet sizing were preserved. Browser checks covered 48 stress cases and three fresh-submission viewport cases, including labels, selection, hit areas, and bounds.

## 17. Security

Authenticated ownership/class checks remain enforced. Unauthorized students/teachers and unauthenticated requests are covered. Hidden numeric marks are redacted on the server and guarded in both presentation layers. No new public report route, credential logging, or production-data export was introduced. QA artifacts contain test identities.

## 18. Performance

Additional normal-runtime AI calls: 0. OCR calls: 0. API calls: 0. Target resolution reuses the loaded canonical transcript and cached in-memory page/word maps. No duplicate database scan was added; a redundant assignment lookup was removed from PDF access handling.

## 19. Database Changes

No schema migration or application/production record mutation. Tests created and cleaned isolated test records and temporary image data. Scoring, entitlements, payments, promo counters, OCR evidence, and persisted correction records were not modified by the implementation.

## 20. Tests

- Backend comprehensive regression: 215/215 passed across 11 suites.
- Latest affected backend suites after detailed-feedback updates: 102/102 passed.
- Frontend final regression: 189/189 passed.
- Browser stress and fresh-submission checks: no collisions or out-of-bounds badges.
- Real PDF generation, extracted-text assertions, and visual inspection: passed.

Coverage includes target authority, anchors, legacy fallback, all-member grouping, hidden scores, preserved qualitative feedback, authorization, readiness, PDF assets, and cancellation. Twelve stale PDF-layout expectations were reproduced against untouched HEAD before updating them to the existing runtime geometry; production geometry was not changed to satisfy those expectations.

Evidence logs at workspace root: `tmp/feedback-consistency-backend-complete.log`, `tmp/feedback-consistency-backend-latest.log`, `tmp/feedback-consistency-frontend-latest.log`; structured summary: `output/feedback-consistency/verification-summary.json`.

## 21. Build / TypeScript / Lint / Diff

TypeScript app noEmit: passed. Production build: passed, with existing CommonJS/CSS budget warnings. Changed-file lint comparison: 250 baseline findings, 249 current findings, zero new findings; lint is not globally clean. Both repositories pass git diff --check (line-ending notices only).

## 22. Remaining Risks

Live provider assessment and physical-device QA remain controlled-QA follow-ups. Existing lint debt and build warnings remain. Legacy records without canonical word targets necessarily retain bbox/character-offset fallback; this does not override a valid explicit target. Dense mixed-code badges use abbreviated visible text with complete member details. No deployment was performed.

## 23. Final Verdict

READY FOR CONTROLLED QA
