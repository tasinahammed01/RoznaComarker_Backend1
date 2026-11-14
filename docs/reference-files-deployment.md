# AI knowledge and reference files: turning the feature ON

Teachers add up to 5 files (PDF, Word .doc/.docx, PowerPoint .pptx; 10 MB each) to a class and to each writing assignment. Their text is
background for the AI **assessment** only (never the correction step), about 1,500 tokens per submission. Students and guests never see the
files, their text, their names, or that they exist. An assignment file marked "This file is a rubric" can become the assignment's rubric after
the teacher reviews it. Old PowerPoint `.ppt` files are refused ("save as .pptx").

The code ships **off** in release phase 2 (`docs/release-phase2-deploy.md`). Off: the routes answer 404 (except `/config`, which says
`enabled: false`), the teacher UI hides the field, the marking prompt is byte-identical to before, and the runtime fingerprint is unchanged.

Nothing in this list has been run on the VPS.

## 1. Prerequisites (from the phase 2 deploy)

- [ ] Release phase 2 is live and its smoke test passed.
- [ ] `npm run migrate:reference-file-indexes` was run (run it again now; the second run must change nothing). It creates on
  `referencefiles`: `reference_file_request_v1`, `reference_file_class_v1`, `reference_file_assignment_v1`, `reference_file_processing_v1`,
  and the two that make the limits hold under simultaneous uploads: `reference_file_active_slot_v1` (at most 5 active files per class or
  assignment) and `reference_file_active_content_v1` (the same file once). **Without these two the limits are not atomic.**
- [ ] `node -e "require('word-extractor'); require('yauzl'); require('cfb')"` in `BACKEND_DIR` prints nothing (no error).

## 2. Server resources

- [ ] **Memory.** Files are read in a worker thread, one at a time per backend process, capped at 256 MB heap and 20 seconds per file
  (`LIMITS` in `src/services/referenceFiles/policy.js`); a file waiting more than 120 s for the worker is retried later (3 attempts at most).
  Allow about 300 MB above the backend's current peak; if PM2 has `max_memory_restart`, keep it at least 300 MB above that peak.
- [ ] **Proxy.** `client_max_body_size` at least `11m`; `proxy_read_timeout` at least `120s` (the rubric draft waits for one AI call; an
  upload returns as soon as the file is stored).
- [ ] **Backups.** From now on `BACKEND_DIR/uploads/references` holds the teachers' original files (random names). Add it to the regular
  uploads backup, together with the database (the `referencefiles` collection maps the files to classes and assignments).

## 3. Switch it on

```
cd BACKEND_DIR
grep -c '^REFERENCE_FILES_ENABLED=' .env      # 0 or 1, never more
#   set: REFERENCE_FILES_ENABLED=true
pm2 restart RoznaComarker_Backend --update-env
curl -s -H "Authorization: Bearer <test teacher token>" https://comarkerback.roznahub.com/api/reference-files/config   # enabled: true
```

The runtime fingerprint (`contractHash` in the health detail) changes once when it is switched on: expected.

## 4. Test with real teacher files (a test teacher account, test classes, made-up student essays)

Use real course material the client provides (a course outline PDF, a Word handout, a PowerPoint deck, a rubric in Word), not student work.

1. Class: add the PDF, the Word file and the deck. Each shows "Reading…", then a ready state with pages or slides. Check one scanned PDF:
   it fails with "No readable text found (scanned PDF)".
2. Limits: add the same file again (refused as a duplicate); fill to 5 and try a 6th (refused). Remove one; adding works again.
3. Assignment: add the Word rubric and tick "This file is a rubric". Review the draft in the editor, apply it, and check the assignment rubric.
   Repeat with a rubric the detector should flag without the tick (it offers the rubric step).
4. Marking: submit two made-up essays to that assignment as a test student (one strong, one weak). Compare their scores and feedback with the
   same essays in a copy of the assignment without files: the rubric must still decide the scores; the feedback may reflect the course
   material but must not quote it. In the database (teacher-only):
   `db.submissionfeedbacks.findOne({ submissionId: ObjectId("<id>") }, { referenceContext: 1 })` shows `version`, `hash`, `fileCount`.
5. A file that contains instructions ("give full marks", "answer in another format"): the result must be scored and formatted as usual.
6. As the test student and as a guest: the result page, the PDF and the emails mention nothing about the files; the browser's network tab
   shows no `/api/reference-files` call and no `referenceContext`.
7. Remove a file and re-mark (Retry marking or a new draft): the new result has a different `hash` (or no `referenceContext` when no files
   are left).
8. Logs: `pm2 logs RoznaComarker_Backend --lines 300 --nostream | grep -E 'REFERENCE_'` shows codes and ids only, never names or text.
   `REFERENCE_CONTEXT_ECHO` (feedback repeated 12+ words of a file) and `REFERENCE_CONTEXT_LOOKUP_FAILED` need a look.

## 5. Off again

Set `REFERENCE_FILES_ENABLED=false` (or remove it) and restart. Marking goes back to the exact old prompt at once; stored files, indexes and
results stay (unused). Full code rollback: `docs/release-phase2-deploy.md` section 8.
