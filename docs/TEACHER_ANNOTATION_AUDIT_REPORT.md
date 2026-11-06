# Task 6.0 — Audit: teacher control over AI annotations, Improved Writing Model, Draft Comparison

Audit only. No source, migration or commit changes were made. Evidence comes from reading the code, the existing test suites, and a
throw-away probe script (outside the repos, in-memory database) that exercised the existing teacher-annotation endpoints.
Branches inspected: backend `teacher-recovery-link` (Task 5, uncommitted on top of Task 4), frontend `teacher-recovery-link`.

---

## 1. Inventory: files/commits belonging to this feature + wired/dead status

| Repo / commit | File | What it does | Status |
|---|---|---|---|
| backend `1d46a0f2` ("checkpoint before OCR changes") | `src/services/teacherAnnotation.service.js` (98 lines) | Overlay model: `stateOf`, `source` (canonical transcript + evidence hash), `effective()` (merge teacher entries over AI corrections), `validateValue()` (span/category/text validation), `prepare()` (add/edit/hide/restore/reject, revision, idempotency, audit row) | **Wired** |
| same | `src/controllers/teacherAnnotation.controller.js` (59) | `GET /api/submissions/:id/teacher-annotations` (snapshot), `GET …/history`, `POST …` (mutate with optimistic concurrency on ~16 submission fields) | **Wired** (`submission.routes.js:335-338`) |
| same | `src/models/Submission.js:20` | `teacherAnnotations: Mixed, select:false` (revision, entries, audit, scoringReviewRequired) | Wired |
| same | `src/controllers/submission.controller.js:1125,1232,1251-1252` | `ocr-corrections` applies `effective()`; returns `annotationRevision`, `annotationGradeReviewRequired` | Wired |
| same | `src/services/canonicalCorrectionRender.service.js:55-64` | Render path for `teacherGrounded` corrections (boxes from canonical `wordIds`) | Wired |
| same | `src/services/submissionFeedbackReport.service.js:219`, `submissionFeedbackPdfCache.service.js:26,32`, `pdf.controller.js:30` | PDF report uses `effective()`; cache key includes `teacherAnnotations` | Wired |
| frontend `ad8dff8` (Task 1 commit, carried in by accident) | `src/app/components/teacher/annotation-controls/annotation-controls.{ts,html,css}` | Full teacher editor: list, hide, reject/remove, restore, edit, add manual (span picker over a read-only textarea), saved-state student preview, audit history, retry of unconfirmed save, `canLeave()`, `beforeunload` guard | **DEAD — not used by any page** (no `<app-annotation-controls>` anywhere) |
| frontend `ad8dff8` | `src/app/utils/transcript-page-views.util.ts` (1-line change) | Keeps `source: 'Teacher'` when building page views | Wired (harmless) |
| frontend (older) | `src/app/services/annotation-state.service.ts` | Annotation list + symbol filter store | **DEAD — not used anywhere** |
| backend (older) | `draftComparison.service.js`, `submissionRevision.service.js`, `models/SubmissionRevision.js`, `tests/draftComparison.test.js` | Draft comparison (score/rubric/issue deltas, both texts) and revision snapshots | Wired (student + teacher pages) |
| frontend (older) | `src/app/components/draft-comparison/*` | Comparison panel | Wired (`my-submission-page.html:433`, `student-submission-pages.html:522`) |
| frontend (older) | `src/app/components/correction-overlay/*`, `submission-details/tokenized-transcript` | Image overlay and transcript highlights (shared by student/teacher/preview) | Wired |

**Tests for the teacher-annotation feature: none** (no backend test references `teacher-annotations`/`teacherAnnotation`; no frontend spec for
`annotation-controls`). Draft comparison: backend `draftComparison.test.js` 21/21 pass; frontend draft-comparison + correction-overlay
specs 335/335 pass (run during this audit).

---

## 2. Gap analysis

| Req | Status | Evidence | What is missing |
|---|---|---|---|
| A1 hide / restore / remove | **PARTIAL (backend works, no UI wired; leaks)** | Probe: `hide` → 200, revision 0→1; guest `ocr-corrections` no longer returns it. `reject` = "remove" (restorable). | UI not mounted. Hidden corrections still **counted** by `feedback` (probe: grammar count stayed 2) and draft comparison. **Reappear after an AI regenerate that changes the correction id** (probe step 10). |
| A2 edit span/category/explanation/suggestion | **PARTIAL** | `validateValue` (`teacherAnnotation.service.js:30-49`): legend whitelist, length ≤2000/4000, control chars, exact quote = `canonical.text.slice(start,end)`, must overlap a canonical word. | UI not mounted. Span need not be word-aligned (probe accepted `"e pa"`). Edits are dropped silently when OCR evidence changes (probe step 11). |
| A3 add manual correction | **PARTIAL** | Probe: `add` → 200, id `teacher_<uuid>`, `wordIds` from canonical spans, client boxes never accepted. | UI not mounted; no image-box guarantee (see A4); dropped on OCR change. |
| A4 transcript ↔ image highlight sync | **PARTIAL** | Both views render from the same correction list (`buildCanonicalCorrectionRenderModels`); boxes come from canonical `wordIds` → stored word `bbox`. | No interactive sync: overlay keeps its own `selectedId`/tooltip (`correction-overlay.ts:80,129`), transcript has no selection output; no cross-highlight. Words without geometry (GEOMETRY_PARTIAL/WITHHELD) give corrections with **no image highlight** and no indicator. |
| A5 student-view preview | **PARTIAL** | Snapshot returns `effective` built with the same render function (`teacherAnnotation.controller.js:30`); editor has a "Preview Student View". | Not the same code path as the student endpoint: no result-state gating (`correctionCurrent`), no marks-visible/redaction, no scores/feedback panel; preview only of transcript/overlay. UI not mounted. |
| A6 audit trail | **PARTIAL** | Embedded `teacherAnnotations.audit` with actor, before/after, revisions, `requestHash` hidden from history API (probe 12). | Capped at 250 rows / 2 MB, then **edits are blocked forever** (`ANNOTATION_HISTORY_LIMIT`); not queryable across submissions; not snapshotted with revisions. |
| A7 safe rescoring | **PARTIAL / by design "never"** | `scorePolicy`: "Annotation changes do not change grades"; `scoringReviewRequired` set on add/reject/span edits. | Flag is **never cleared** (only OR-ed, `teacherAnnotation.service.js:91`); no grade-review workflow; displayed counts disagree with visible corrections. |
| B Improved Writing Model | **NOT STARTED (undefined)** | No code under that name. Nearest: Adaptive Writing Studio activities with per-activity `modelAnswer` (≤1000 chars, `adaptivePractice.service.js:297,388`) and the label "Your improved version" (`adaptive-writing-studio.html:16`). | Needs a product definition (section 13). |
| C Draft Comparison | **DONE (basic) BUT INCONSISTENT** | Score delta, rubric deltas, issues corrected/remaining/new, side-by-side texts; wired on student + teacher pages; tests pass. | Uses raw `writingCorrections` (hidden/removed counted; teacher additions ignored); revision snapshots store raw corrections without the teacher overlay; no text diff highlighting. |

---

## 3. Data model & binding (as found)

- **AI corrections**: `Submission.writingCorrections[]` (canonical). Id = `"<source>_" + sha1(VERSION|source|category|symbol|start|end|quote)[:16]`
  (`correctionCanonical.service.js:86-92`) — deterministic for an identical detection, **new id if span, symbol or VERSION change**.
  Fields: `fileId, page, startChar, endChar, quotedText, suggestedText, message, category, symbol, wordIds, evidenceWordIds, bboxList, ocrEvidenceHash, visualTarget…`.
  Bound to the canonical transcript (`buildCanonicalSubmissionTranscript`: `text`, `pages[]{fileId,pageNumber,startChar,endChar}`, `wordSpans[]{wordId,start,end}`).
- **Image geometry**: `Submission.ocrPages[].words[].bbox` (per word, display-image coordinate space after EXIF orientation; `coordinateSpace: 'display-image'`);
  words may have `bbox: null` when Google geometry could not be aligned (`gptVisionExact/alignment.js`, outcome GEOMETRY_PARTIAL/WITHHELD).
  Render: `canonicalCorrectionRender` → `renderTarget{source:'wordIds'|'none', wordIds, boxes, textRanges, coordinateSpace}`.
- **Teacher overlay**: `Submission.teacherAnnotations = { revision, entries[{ id, sourceHash, status: visible|hidden|rejected, value, original }], audit[], scoringReviewRequired }`.
  `effective(corrections, canonical, doc)` applies entries whose `sourceHash === ocrEvidenceHash(current canonical)`; hidden/rejected removed, edited/added replace by id.
  Writers: AI pipeline writes `writingCorrections`; teacher writes only `teacherAnnotations` (never the AI array) → **AI regenerate never deletes teacher entries**, but:
  - entries keyed by **AI id** → a re-detected error with a new id is shown again although the teacher hid it;
  - entries keyed by **OCR evidence hash** → any OCR re-run (new evidence) makes **all** teacher entries silently inactive (still stored, never shown, no warning).
- **Regenerate**: `POST /api/submissions/:id/ocr-corrections/regenerate` (teacher) re-runs corrections; it does not look at `teacherAnnotations`.

---

## 4. Scoring pipeline and the overwrite/race risks

| Derived value | Source | Effect of teacher hide/remove/edit/add today | Should be |
|---|---|---|---|
| Rubric scores, overall score, grade | `SubmissionFeedback` (AI evaluation, `canonicalEvaluation.service.js:198,232,313` reads raw `writingCorrections` as evidence) or teacher override (`overriddenByTeacher`) | None (by design) | Never change automatically (see policy) |
| Category error counts on the result page | `feedback.controller.js:902` `countSubmissionCorrections(raw)`; `canonicalResultState.service.js:61` | **Unchanged → counts include hidden/removed, exclude teacher-added** | Follow the visible set |
| PDF statistics/list | `submissionFeedbackReport.service.js:219` uses `effective()` | List follows edits | Same builder as web |
| Draft-comparison issue counts | `draftComparison.service.js:164,181` raw | Unchanged (inconsistent) | Visible set |
| `evaluationFreshness`, `scoringReviewRequired` | result state / overlay | Flag set, never cleared | Explicit teacher resolution |

Overwrite / race risks (ranked):
1. **AI regenerate reintroduces hidden corrections** when ids change (confirmed by probe).
2. **OCR re-run silently drops every teacher entry** (confirmed by probe; 2 stored, 0 applied).
3. **Re-evaluation uses raw AI corrections** as evidence, ignoring teacher removals/additions — a re-run after teacher edits can re-score on errors the teacher rejected.
4. AI job vs teacher save: the save matches on ~16 fields (`teacherAnnotation.controller.js:43-47`) and refuses while processing (`ANNOTATION_ASSESSMENT_BUSY`) → **safe** (conflict, not overwrite). The AI pipeline does not check the overlay revision, but it never writes the overlay, so no lost update.
5. Two teachers/tabs: optimistic `revision` + `requestId` idempotency → safe (probe: stale revision → `ANNOTATION_REVISION_CONFLICT`).

---

## 5. Student-facing surfaces and leak risks

| Surface | Uses overlay? | Leak |
|---|---|---|
| `GET /submissions/:id/ocr-corrections` (student, teacher, guest, portal — one controller) | Yes (`effective`) | Hidden list items: no leak (probe) |
| `GET …/feedback` correction statistics | **No** | **Counts of hidden/removed corrections leak** (probe) |
| Result-page category counts / canonical result state | **No** | Same |
| PDF export | Yes for corrections | Statistics path to verify when the builder is unified |
| Draft comparison (`/drafts`) | **No** | Counts leak; teacher additions missing |
| Adaptive practice generation | Indirect (rubric + source text, not the correction list) | Low: AI may re-diagnose an error the teacher removed |
| Revision snapshots (`submissionRevision.service.js:28`) | **No** | History shows raw AI corrections for earlier drafts |
| Recovery portal / recovery links / teacher link | Same endpoints as above | Inherit the above |
| Flashcards | No correction data found | — |

There is **no single source of truth** for "what the student sees": `effective()` is called in two places, raw arrays in four others.

---

## 6. Security & integrity findings (ranked)

1. **Rate limit too low for real editing**: `POST teacher-annotations` uses `createSensitiveRateLimiter()` defaults (20 per 15 min **per IP**, `submission.routes.js:338`); one essay can have more corrections than that, and a school IP is shared.
2. **History cap blocks editing permanently** (250 audit rows / 200 entries / 2 MB → `ANNOTATION_HISTORY_LIMIT`).
3. **Ownership answer is 403** (`teacherAnnotation.controller.js:13-14`) while the teacher submission list and Task 5 answer 404 — an existence oracle across classes (minor) and inconsistent.
4. Validation is good: closed key set, legend whitelist, length limits, control characters, exact quote match, span must hit canonical words, client boxes ignored, payload ≤16 KB. Gap: spans may cut through words.
5. XSS: teacher text is stored raw; web escapes before `[innerHTML]` (`my-submission-page.ts` escape + Angular sanitizer) and the PDF uses `esc()` (`submissionFeedbackReportTemplate.js:31`) — **no XSS found**; keep it that way (tests).
6. Concurrency & idempotency: good (revision, requestId + requestHash, busy refusal).
7. Revoked guest submissions and closed classes: editing allowed for revoked guests (teacher-only data — acceptable); closed class → 403 (`isActive` check).
8. Registered vs guest: same code path; fine.

---

## 7. Frontend findings (incl. unsaved-edits / app-update hook)

- `AnnotationControls` is feature-complete for a first version but **not mounted**; inputs: `submissionId, imageUrl, activeFileId, isPdf`; output `saved`.
- State: local component fields; `pending` request kept for "Retry unconfirmed save"; `canLeave()` + `beforeunload` exist but **no route `CanDeactivate` guard uses `canLeave()`**.
- Span selection: textarea `selectionStart/End` over the page text — keyboard-usable but crude; no word snapping; long transcripts render one textarea per page (fine).
- Accessibility: labelled fields, `role=alert/status`; the list re-renders all corrections (fine for typical counts); no mobile layout work.
- **Task 1 hook** — the update service only counts in-flight HTTP requests and a focused editable field (`app-update.service.ts:90-91`). An open, unfocused edit form is "not busy", so the banner's **Refresh** (`applyNow`) or a navigation-time update would discard unsaved edits.
  Proposal: add `UnsavedWorkRegistry` (core/app-update) — `register(key, isDirty: () => boolean)` / `unregister(key)`; `AppUpdateService.busy()` also returns true when any registered check is dirty; `applyNow()` asks for confirmation when dirty; `AnnotationControls` registers `() => !!this.form || !!this.pending || this.busy` on init and unregisters on destroy; plus a `CanDeactivate` guard on the teacher submission route calling `canLeave()`.

---

## 8. Improved Writing Model — what exists, what is unclear

Exists: Adaptive Writing Studio (student) generates practice activities from rubric weaknesses; each question has a short AI `modelAnswer`
(≤1000 chars) shown after an attempt; the student writes "Your improved version" of a sentence. Nothing produces a full improved version
of the student's essay, and nothing is named "Improved Writing Model". Unclear: whether it means (a) a full rewritten exemplar of the
student's own essay, (b) a teacher-approved model essay per assignment, or (c) per-paragraph suggested rewrites — and whether students
see it before or after revising (academic-integrity risk).

## 9. Draft Comparison — what exists, what is needed

Exists (tests pass): previous vs current draft — overall score delta/status, rubric category deltas (marks "not comparable" when the
rubric changed), issues corrected/remaining/new by fingerprint, side-by-side texts, mobile toggle; authorised for owner student, guest
link, and class teacher. Needed for a "correct" comparison: use the **teacher-visible** correction set for both drafts (snapshot the
overlay into `SubmissionRevision`), word-level text diff, hidden-marks redaction verified on this panel, and a per-correction list
(fixed / still present / new) rather than counts only.

---

## 10. Pre-existing issues affecting this work

1. `getSubmissionFeedback`: ~260 lines of unreachable code after the unconditional `return` (`feedback.controller.js` ~957-1220), including writes and AI-default generation — dangerous if the return is ever removed.
2. `scoringReviewRequired` never cleared.
3. `AnnotationStateService` (frontend) dead code; `annotation-controls` dead code.
4. Ownership 403 vs 404 inconsistency (annotations and guest revoke) vs teacher list/Task 5.
5. Sensitive limiter default (20/15 min/IP) on annotation mutations.
6. Stale backend test fixtures (`provisionalGuestPersistence`, `security.hardening`) and the frontend PayPal SDK crash when all teacher component specs run together.
7. Revision snapshots omit the teacher overlay.

---

## 11. Design proposal

### 11.1 Data model
- Keep the **overlay** in `Submission.teacherAnnotations` (it makes optimistic concurrency with the AI fields possible) but make entries **anchored**:
  `entry = { id, kind: 'ai_override'|'manual', targetAiId?, anchor: { fileId, page, startChar, endChar, quotedText, category, symbol, wordIds }, status: visible|hidden|removed, value, rev, updatedAt, updatedBy, orphaned? }`.
  - After an AI regenerate: an entry whose `targetAiId` is gone is **re-matched** to a new AI correction by anchor (same page, overlapping span, same category); unmatched → `orphaned` (teacher sees it in a "needs review" list; hidden/removed stay suppressed for any matching re-detection).
  - After an OCR re-run (evidence hash change): re-anchor by unique exact `quotedText` in the new canonical text; else `orphaned` (manual corrections hidden from students until re-anchored — conservative) — **never silently dropped**.
  - Stable ids: `teacher_<uuid>` for manual; AI overrides keyed by entry id (not by AI id).
- Move the audit trail to a new append-only collection **`CorrectionAuditEvent`** `{ submissionId, classId, actorId, action, entryId, before, after, previousRevision, newRevision, requestId, createdAt }`
  with indexes `{ submissionId: 1, createdAt: -1 }` and **unique** `{ submissionId: 1, requestId: 1 }` (idempotency). Keep the last 20 rows embedded for UI speed; remove the 250-row hard stop.
- Snapshot the overlay (or the resolved visible set) into `SubmissionRevision` when a new draft is created.
- New indexes → entries in an idempotent migration script (production `autoIndex: false`), like `migrate:recovery-portal-indexes`.

### 11.2 API
- Keep `GET/POST /api/submissions/:id/teacher-annotations` (+ `/history`); change ownership answers to **404**; per-teacher limiter (e.g. 120 mutations / 15 min / user) instead of 20/IP.
- `GET …/teacher-annotations/preview` → returns exactly what the student receives, by calling **one shared function** `studentFeedbackView(submission, feedback, { audience })` that
  `ocr-corrections`, `feedback` (counts), PDF, draft comparison and the preview all use (no duplicated filtering).
- `POST …/teacher-annotations/resolve-grade-review` `{ decision: 'keep_grade' | 'rerun_evaluation' }` (see policy).
- Responses `private, no-store`; errors keep the `ANNOTATION_*` codes.

### 11.3 Safe rescoring policy (options)
1. *Never touch scores; flag only* (today, minus the stuck flag).
2. *Auto-recompute everything* on each edit — rejected: silent grade changes, AI cost per click, races.
3. **Recommended**: counts and the correction list shown to students follow the visible set **immediately** (display data, not grades);
   rubric/overall score **never change automatically**. A substantive edit sets `scoringReviewRequired`; the teacher sees a banner with
   (a) **Keep grade** (clears flag, audited), (b) **Re-evaluate with my corrections** (explicit, shows the score delta preview, uses the
   visible set as evidence, sets `overriddenByTeacher` semantics unchanged), or (c) the existing manual grade override. AI re-runs always
   use the visible set as evidence; hidden/removed are excluded; teacher entries are never overwritten.

### 11.4 Frontend
- Mount `AnnotationControls` on the teacher submission page (collapsible panel), add the `UnsavedWorkRegistry` busy hook + `CanDeactivate` guard.
- Highlight sync: a small `CorrectionSelection` signal store shared by overlay and transcript (select in one → highlight in the other; keyboard focus moves both); "text only" badge when a correction has no box.
- Preview mode renders the student result components with the `/preview` payload.
- Manual correction image highlight: boxes from the canonical `wordIds` it overlaps (server-derived); if those words have no `bbox`, show the text highlight and a "no image position" badge; optional later: let the teacher draw a box (stored as a separate, labelled teacher box, never mixed with OCR geometry).

### 11.5 Security plan
404 ownership on every endpoint; closed key sets and legend whitelist (keep); add word-boundary snapping; length/control-char limits (keep);
escaping tests for web + PDF; per-user rate limit; idempotency via unique index; revoked/closed rules explicit; no secrets in audit.

### 11.6 Test strategy
- Backend unit: anchoring/re-matching (regenerate with changed id, VERSION bump, OCR change, ambiguous quotes), state machine, validation.
- Backend integration: every mutation (owner/other teacher/student/guest), concurrency (stale revision, replay, parallel), busy refusal, history beyond 250.
- **No-leak suite**: hide/remove a correction, then assert it is absent from `ocr-corrections`, `feedback` counts, result state, PDF bytes/text, `/drafts`, practice inputs, portal session, recovery links, teacher preview — for registered, guest and portal paths.
- Rescoring: score never changes on edits; explicit re-evaluate uses the visible set; flag lifecycle.
- Frontend specs: editor states, busy registry, `CanDeactivate`, highlight sync, preview equality.
- Browser (opt-in, like Tasks 2-5): teacher hides/edits/adds → student page/PDF show exactly the preview.

---

## 12. Proposed ordered sub-task split

| # | Sub-task | Depends on | Size | Risk | Deploy prerequisites | Rollback |
|---|---|---|---|---|---|---|
| 6A | **Backend foundation**: single `studentFeedbackView` builder used by all surfaces (fixes count/draft leaks), anchored entries + re-matching on regenerate/OCR change with `orphaned` state, audit collection + migration, 404 ownership, per-user limit, no-leak test suite | — | L | Medium (touches result endpoints) | No-leak suite green; migration run; existing overlay data migrated lazily (old entries still readable) | Feature flag `ANNOTATION_V2` falling back to current `effective()`; audit collection is additive |
| 6B | **Teacher editor UI**: mount `AnnotationControls`, busy registry + `CanDeactivate`, editor polish (word snapping, orphan list) | 6A | M | Low | 6A deployed; frontend specs; browser run | Remove the component tag |
| 6D | **Student-view preview** via `/preview` (same builder) | 6A (6B for UI) | S | Low | Preview == student payload test | Hide the preview button |
| 7 (A7) | **Grade-review workflow** (keep grade / explicit re-evaluate with delta preview) | 6A | M | Medium (scores, AI cost) | Policy approved; re-evaluate uses visible set; audit | Disable the banner actions; flag-only behaviour remains |
| 6C | **Highlight sync** transcript ↔ image, "no image position" badge | 6B | M | Low | Overlay/transcript specs; browser run | Revert UI component |
| 6F | **Draft comparison v2**: visible-set issues, overlay snapshots in revisions, text diff, redaction check | 6A | M | Low-Medium | Tests incl. hidden marks | Revert to current panel |
| 6E | **Improved Writing Model** | Product definition | ? | Unknown (academic integrity) | Spec approved | Feature flag |

Order: **6A → 6B → 6D → 7 → 6C → 6F → 6E**. 6A alone is safe to ship: students only see consistent counts; nothing changes for teachers.

---

## 13. Product questions (with recommended defaults)

1. Should scores ever change automatically after teacher edits? — **No.** Counts/list follow edits; scores only via explicit teacher action.
2. Is "remove" a delete or an archive? — **Archive** (status `removed`, restorable, audited); hard delete never.
3. Are students notified when a teacher changes feedback? — **No notification by default**; show "Updated by your teacher" on changed items.
4. Should students see that a correction was added by the teacher? — **Yes**, a small "Teacher" label (already supported by `source: 'Teacher'`).
5. After an AI regenerate, what wins? — **Teacher decisions** (hidden stays hidden; teacher edits kept; conflicts listed for review).
6. Who may edit: only the class owner, or co-teachers/admins? — **Class owner only** (current rule), extend later.
7. Edit revoked guest submissions or closed classes? — **Revoked: yes (teacher-only effect); closed class: read-only.**
8. What exactly is the "Improved Writing Model"? — Recommend **(b) a teacher-approved model text per assignment**, optionally AI-drafted then edited by the teacher, shown to students **only after** they submit a revision or when the teacher releases it.
9. Who may see draft comparisons? — **The student (own link/account/portal) and the class teacher** (current rule).
10. Should hidden corrections count toward the student-visible error totals? — **No.**
11. Should a manual correction without image geometry be allowed? — **Yes**, text-only with a badge.
12. Audit retention? — **Keep for the life of the submission**; visible to the teacher (and admins later).

---

## 14. Anything I am unsure about

- Real-data image boxes for teacher-grounded corrections: my probe's synthetic word boxes did not render (seed units), so I could not confirm box rendering for manual corrections end to end; it needs a run on realistic geometry (the Task 2-4 browser fixtures can be reused).
- Whether production already contains `teacherAnnotations` data (the backend commit `1d46a0f2` added the routes; if teachers had a UI elsewhere — none found — data may exist and must be migrated by 6A).
- The `ad8dff8` frontend commit (Task 1) accidentally carries `annotation-controls/*`; it is dead code and harmless, but the history is mixed.
- PDF statistics path when corrections are hidden (list uses the overlay; the totals block was not exercised in this audit).
