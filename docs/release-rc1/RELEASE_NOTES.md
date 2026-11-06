# What is new in this release (Release Candidate 2)

## For teachers

**You can now review and correct the AI's corrections before students see them.**
Open a submission and use **Review corrections**. You can hide a correction, bring it back, remove one, change its wording or category, or add one of your own. Everything you do is saved, listed in a change history, and shows up in the student's page, counts and PDF straight away. Students never see what you hid.

**Student preview.**
One button shows exactly what the student will see, using what you have saved. Nothing is sent to the student by opening it.

**Grade check.**
When you change which corrections count, the page reminds you to look at the grade again. It shows the current scores next to how many issues were counted and how many the student now sees. **Keep these scores** records that you checked them. Scores are never changed automatically, and they cannot be edited from this screen yet.

**Recovery links.**
If a guest student loses their link, you can send them a new one from the submission.

## For students

- Your results, scores and PDF now match what your teacher decided to show you.
- Your teacher appears by name. Nobody's email address is shown.
- If your teacher adds a correction in an area the AI did not flag, that area now gets its own improvement card.

## For guests (no account)

- **One link for everything.** If you submitted more than one assignment with the same email, a single link now lists them all.
- Asking for a new link a second time tells you how long to wait instead of silently doing nothing.
- A link that has expired or been switched off now explains what happened and how to get a new one.

## For everyone

- **The app updates itself.** When a new version is published, an open tab picks it up at a quiet moment. It will not interrupt you while you are typing or editing.
- Typing is safer on smaller screens: changing the window size or rotating a tablet across the desktop and tablet layout no longer rebuilds the page and loses what you typed. Pop-up forms (create class, create assignment, invite students, rubric designer) are not covered yet: finish them before resizing.

## Behind the scenes (for the school's administrator)

- Student pages no longer receive teacher email addresses or the AI pipeline's provider, model and processing details.
- The public health check now answers with a simple "OK". Detailed technical information needs a secret key.
- Two small database setup steps are run once at release time. They do not change anyone's data. One optional conversion of older teacher edits, which can be undone, applies only if such edits exist.

## What to expect on the day

- No downtime is planned beyond a normal restart of the server (a minute or two).
- After the update, teachers may see **Check needed** on submissions where they had already hidden or removed corrections earlier. This is expected: press **Keep these scores** once, or ignore it.
- Students and guests will not notice a change, other than seeing their teacher's name.
