# Release candidate 2: manual QA checklist

Use a staging copy or, after the deploy, a designated test class on production. Never use a real student's work.
Mark each step Pass or Fail. **[DEVICE]** needs a real device (iPad Safari or a phone). **[MAIL]** needs a real mailbox you can open.
**[ADMIN]** needs a server shell. Automated browser checks already cover these flows with synthetic data; this list is for what a machine cannot judge: feel, wording, real devices and real mail.

Prepare once: a teacher account with a class and one essay assignment (guests allowed); a registered student in the class; a guest submission made with a mailbox you own; at least one submission that has finished assessment with a few corrections; one worksheet and one flashcard assignment.

---

## A. Teacher

| # | Step | Expected |
|---|---|---|
| T1 | Open a student's submission, scroll to **Review corrections**, press **Open**. | A list of the corrections with state badges (Visible to student, Hidden, Removed, Needs review). Counts line shows "N of M corrections are visible to the student". |
| T2 | Press **Hide** on one correction. | A message "Hidden from the student." The row stays, dimmed, with a "Hidden from student" badge. The visible count drops by one. |
| T3 | Press **Student preview**. | A full-screen preview titled "Preview: this is what the student sees". The hidden correction is missing, its count is lower, and nothing about the grade check shows. **Close** returns focus to the preview button. |
| T4 | Press **Restore** on the hidden row. | "Restored. The student can see it again." Count returns. |
| T5 | Press **Remove** on a row. | A confirmation says it can be restored at any time and that the action is recorded. Confirm: the row shows "Removed" and stays in the list. |
| T6 | **Add correction**: select words in the transcript, choose a symbol, type an explanation and a suggestion, save. | The correction appears with a "Teacher" badge. A save with the form empty shows field errors and does not save. |
| T7 | **Edit** an AI correction (change the explanation only). | Saved; badge "Edited by you". The grade check does **not** become "needed" for a wording-only edit. |
| T8 | Start typing in **Add correction**, do not save, then try to leave the page. | The browser asks before leaving. Cancel the form: the prompt no longer appears. |
| T9 | Open **Change history**. | One readable row per action, newest first, with date and time. |
| T10 | After T2, look at **Grade check**. | "Check needed. Corrections changed after these scores were set. Check the grade." Overall, grade and category scores are shown, plus lines like "Grammar: 7 when scored, 5 shown to the student". |
| T11 | Type a short reason and press **Keep these scores**. | "Checked." with the time, "by you" and the reason. The scores are exactly as before. The history has a "Grade checked" row with the reason. |
| T12 | Hide another correction. | "Check needed" returns; the earlier check stays on show as the last one. |
| T13 | While **Add correction** has unsaved text, look at the Keep button. | It is greyed and says why ("Save or cancel your correction first"). |
| T14 | Open the same submission in two tabs. Hide a correction in tab 2, then press Keep in tab 1. | A plain message that the submission changed; nothing was recorded; the reason you typed is still in the box. |
| T15 | **[DEVICE]** On an iPad, rotate between portrait and landscape with a reason typed. | The reason stays, nothing overflows, buttons are easy to tap, the preview opens and closes. |
| T16 | Archive the class (or use a closed one) and open a submission. | The corrections list and the grade check are shown read-only, with a note that the class is closed. |
| T17 | Open a guest submission and use **Send recovery link** (the teacher recovery action). **[MAIL]** | The guest's mailbox receives one link. Pressing it twice in a row does not send a second mail within the cool-down. |
| T18 | Try to edit scores through the old rubric screen. | There is no way to reach it from this page (grading edits are a later release). Nothing breaks. |

## B. Registered student

| # | Step | Expected |
|---|---|---|
| S1 | Open the student dashboard and **My Classes**. | The class card shows the teacher's **name** (never an email). |
| S2 | Open a finished result. | Scores, corrections and feedback render. The line under the title reads "By: <teacher name>". The hidden correction (T2) is not shown, and counts match what is shown. |
| S3 | A category where the teacher **added** a correction and the AI found none. | An "Areas for Improvement" card appears with the count and a revision tip, and **no** "0/0" score badge. |
| S4 | Scores after the teacher pressed Keep. | Identical to before. Nothing mentions a grade check. |
| S5 | Press **Download Feedback PDF**. | A PDF opens with the same corrections and counts as the page, including the S3 card. |
| S6 | Open adaptive practice, generate it, answer a question, check the answer. | The practice appears; the check shows a result; the model answer shows after an attempt. |
| S7 | Open the worksheet assignment and the flashcard assignment (also by scanning its **QR code** **[DEVICE]**). | The QR opens the right page after sign-in. The worksheet shows no answer key. The flashcards flip. |
| S8 | Open the **public flashcard share link** in a private window, signed out. | The cards show without signing in. |
| S9 | Open **Notifications**. | The teacher's notifications show with the teacher's name only. |
| S10 | Join a class with a **join code**, then (another class) with a **link**. | Both join and the class appears in My Classes. |
| S11 | Submit work and, after it finishes, resubmit. | The submission is accepted; processing states are honest; the second draft keeps the first as history. (Needs the real AI services: staging or production only.) |
| S12 | **[DEVICE]** Open the result on an iPad. | Layout holds in both orientations, the correction highlights and tooltips work by touch. |

## C. Guest (no account)

| # | Step | Expected |
|---|---|---|
| G1 | Scan the assignment QR code **[DEVICE]** and submit with a name and an email you own **[MAIL]**. | The page confirms; a confirmation email arrives with a link. |
| G2 | Open the link from the email. | The result page shows scores and corrections like S2; the hidden correction is not shown; no teacher email anywhere. |
| G3 | Ask for a link again at **/recover** with the same email, twice within two minutes. **[MAIL]** | The first request sends a link; the second shows an honest cool-down message ("wait ..."), not a silent success. |
| G4 | Open the **recovery portal** link from the mail. | A list of every submission made with that email. Opening one shows its result. The session ends after the portal time limit. |
| G5 | The teacher **revokes** a guest link (or let one expire), then open it. | A clear page that says the link no longer works and how to get a new one, not a blank or technical error. |
| G6 | A result that is still processing, and one that failed. | "Still processing" and "could not finish" pages, each with a plain explanation. |
| G7 | Download the PDF from the guest result. | A PDF with the same content as the page. |

## D. Admin and operations

| # | Step | Expected |
|---|---|---|
| A1 | **[ADMIN]** `curl -i https://<api>/api/health`. | `{"success":true,"status":"OK"}` only. No `runtime`, no environment, no prompt or model names. |
| A2 | **[ADMIN]** The same with `-H "X-Deploy-Token: $HEALTH_DETAIL_TOKEN"`. | Also `environment`, `timestamp` and `runtime` (contract versions, deployment revision). A wrong token gives the public answer. |
| A3 | **[ADMIN]** `npm run verify:runtime` with the token set. | `MATCH`. Without the token: a clear message that names `HEALTH_DETAIL_TOKEN`. |
| A4 | **[ADMIN]** `curl -I` the site root, a hashed asset and `/version.json`. | Root: `no-cache`. Hashed `.js`/`.css`: `max-age=31536000, immutable`. `version.json`: `no-cache, no-store, must-revalidate`. |
| A5 | Keep a teacher tab open, deploy a new frontend build, wait. | The open tab offers or applies the update when idle; it does **not** reload while a correction form or a typed reason is unsaved. |
| A6 | **[ADMIN]** `npm run report:score-review`. | Four numbers only (flags on, flags without a draft number, overridden feedback, custom rubrics). No names. |
| A7 | **[ADMIN]** After the index migrations, list the indexes of `annotationaudits`. | `annotation_audit_request_v1` (unique) and `annotation_audit_submission_v1`; the TTL index only if `ANNOTATION_AUDIT_TTL_DAYS` is set, and then partial (never expires grade-check rows). |
| A8 | Look at the server log after a day. | No repeated errors; no student text, names, tokens or teacher emails in any line. |

## E. Added for RC2

| # | Step | Expected |
|---|---|---|
| R1 | Type in the annotation editor, a teacher comment, a grade check reason, a worksheet and a flashcard editor without saving. Resize the window from 1100px to 1000px and back. | The text stays, the page does not reload, Save still works. |
| R2 | At 1025px and 1024px compare sidebar, header, bottom navigation, padding and scrolling with the previous version. | The same at each width; no blank gap or second scrollbar. |
| R3 | **[DEVICE]** Rotate a tablet and pinch-zoom with unsaved text in those forms. | The text stays. |
| R4 | Student and guest: open a result with an image (also a rotated phone photo and a several-page one). Click a correction. | The highlight is on the right words. Transcript complete and in order. |
| R5 | In the browser network tab open `ocr-corrections`, `presentation` and the `/my` response. | No `sourcePrimaryModel`, `ocrProvider`, `path`, `provider`, `tokens`. |
| R6 | Draft comparison when the same file was submitted again. | "Issues remaining" follows the current draft. |
| R7 | Known issue: type in the Create Class dialog and resize across 1024px. | The dialog closes and the text is lost. Confirm it is still only this. |
