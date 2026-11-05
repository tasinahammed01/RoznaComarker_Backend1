# What changed since the version now in use

A short summary for the school. Everything below is in this release; nothing has to be switched on by hand except guest submission, which the administrator turns on last.

## Guest submission and link recovery
- Guest submission (students without an account submit by QR code and see their results with a private link) is ready; the administrator switches it on as the last step of the update.
- A guest who loses the link can ask for a new one; one link lists all their submissions with the same email.
- Expired or switched-off links explain what happened and how to get a new one.
- Teachers can send a guest a new link from the submission.

## Teacher control over corrections
- Before students see them, teachers can hide, restore, edit (wording or category), add or remove corrections.
- Every change is recorded in a change history, and removed corrections can be brought back.
- A student preview shows exactly what the student will see.

## Highlights on the page image
- Clicking a correction highlights it in the transcript, the list and on the image, and the other way round.
- Underlines use the colour of the error type (spelling, grammar, vocabulary and so on), sit under the exact word, and the code label sits on that word.
- A sentence-level correction is marked with a bracket in the margin. Corrections that could not be placed on the image are listed, never drawn in the wrong place.

## Grade check
- When a teacher changes which corrections count, the page shows the scores next to what was counted and what the student now sees, so the teacher can confirm the grade with one click. Grades never change on their own.

## Draft comparison
- Comparing drafts uses the corrections as the teacher left them, not the raw AI list.

## Better handwriting reading
- A new reader (Gemini) reads handwriting more completely: no lost lines on the test samples, and the same result every time for the same page.
- It keeps the student's own mistakes in most cases. It still quietly fixes some capital letters (about 3% of words on our samples).
- If the reader may have missed a line, the teacher sees a warning; students never do.

## Correction statistics
- Each category shows the plain number of corrections the viewer sees, and which kinds they are (for example "Spelling 4, Punctuation 2").
- The word "Holistic" is gone. Content and Organization are counted like the other categories; their scores stay in the score panel.

## Adaptive practice
- Practice becomes available on its own as soon as the final evaluation is ready. No teacher action is needed. Practice exercises are still created only when the student asks for them.

## Fixes
- The results page now updates by itself from the provisional score to the final score and detailed feedback; it no longer stays on "out of date".
- Underlines are thinner and never longer than the word.
- Students and guests never receive teacher email addresses or technical details of the AI.
- The PDF report shows the same markers, counts and wording as the website.

## Known limits
- Content and Organization issues are found less often than grammar and spelling issues.
- The number of corrections can differ slightly if the same page is analysed twice.
- A word the reader could not place on the image is listed but not drawn.
- Text typed in a pop-up form can be lost when the window is resized across the tablet size.
- Worksheet answers are visible to a student who opens the browser's developer tools.
- Practice is not offered when the AI could only partly evaluate the work.
