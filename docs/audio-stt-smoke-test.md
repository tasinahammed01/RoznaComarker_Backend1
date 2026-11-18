# Speaking assignments: production smoke test

Follow the steps in order. Use your own test teacher, test student and a test email inbox; never a real class. Each step says what you
should see. If a step does not match, stop and turn the feature off (part D). Background and settings: `docs/audio-stt-deployment.md`.

You need: SSH access to the server, the PM2 name of the backend (below: `<backend-app>`), a teacher and a student test account in the same
test class, a second email address for the guest test, and a short recording on your computer (see "Test recordings" at the end).

## Part A. Deployed, still switched off

1. On the server, in the backend folder: `node --version` shows `v22` or newer.
2. `npm ci` finishes without errors.
3. `npm run migrate:audio-indexes` prints the audio indexes and ends without an error.
4. `AUDIO_STT_ENABLED` is not set to `true` in the backend `.env` (open the file in the editor you normally use; do not paste it anywhere).
5. `pm2 restart <backend-app> --update-env`, then `pm2 logs <backend-app> --lines 100`: a normal start, and **no**
   `audio_transcription_worker_started` line.
6. In a browser, signed out: `https://<your-api-host>/api/audio/config` answers `{"success":false,"code":"NOT_FOUND","message":"Not found."}`.
7. Sign in as the test teacher and open the test class: the button says **Create Writing Assignment** (not "Create Assignment"), and there is
   no speaking choice.
8. Check the essay flows you use every day, quickly: a student uploads an essay; the guest QR page of an essay opens; the recovery page
   (`/recover`) sends a link; "Upload work" for a student works; the assignment report opens; a feedback PDF downloads. All as before.

## Part B. Switch on and test one recording end to end

9. In the backend `.env`, set `DEEPGRAM_API_KEY=<the key>` (once) and `AUDIO_STT_ENABLED=true`. Save.
10. `pm2 restart <backend-app> --update-env`. In `pm2 logs <backend-app> --lines 100` you should see `audio_transcription_worker_started` and
    `speaking_assessment_contract`.
11. As the test teacher, refresh the class page: the button now says **Create Assignment** and offers **Speaking**. Create a speaking
    assignment called "Smoke test", due tomorrow, task "Describe your town", maximum length 3 minutes, default rubric.
12. **Confirm the Deepgram key with a 10-second recording.** As the test student, open "Smoke test", choose "Upload Recording" and upload the
    10-second recording. You should see "Uploaded", then "Turning your recording into text…", and within about a minute either the result or
    "There wasn't enough speech in this recording to mark it."
    - A 10-second answer is usually under 30 words, so "not enough speech" is the expected, healthy answer: the key works, the transcript
      was made, and **no** assessment credit was used.
    - If it says "We couldn't turn this recording into text", the key is wrong or missing: run
      `pm2 logs <backend-app> --lines 300 | grep audio_stt_attempt` and look at `code` (`AUDIO_STT_NOT_CONFIGURED` = no key;
      `AUDIO_STT_REJECTED` with `httpStatus` 401 or 403 = wrong key or no balance).
13. **Confirm marking with a 30 to 60 second recording** (about 60 to 120 words, in English, on the task). Upload it as "Replace recording"
    (still possible before marking). Within a minute or two: "Your recording has been marked.", the transcript with highlights, the rubric
    levels, the fluency figures and the feedback. The teacher's credit count goes down by one.
14. As the teacher, open the class, "View Submissions" on "Smoke test", then the student's recording: the player plays, the transcript and
    the result are there.
15. **Confirm the cost in the Deepgram console:** open the Deepgram console, your project, **Usage**. The two test recordings appear as
    pre-recorded requests with model `nova-3`, about 0.2 and 0.5–1 minute of audio, together well under one cent. If you set a budget alert
    in **Billing**, check it is on.
16. Optional, guests: edit "Smoke test", tick "Allow submission without login", save. Open the card's "QR Code", copy the link, open it in a
    private window, enter a name and your second email, tick the notice, upload the 30–60 second recording. You should see "Your recording was
    received"; the second inbox gets the receipt and, after marking, "Your Rubrilo feedback is ready" with a link that opens the result.
17. Clean up: first remove each "Smoke test" submission from "View Submissions" (removing a submission deletes its recording and releases its
    storage), then delete the assignment. Deleting an assignment only hides it (as for essays): its submissions and their audio stay until
    they are removed.
18. A day later: `npm run audit:audio-storage` should end with "All clear. Nothing was changed."

## Part C. What to watch in the first days

- `pm2 logs <backend-app> | grep -E "audio_stt_attempt|speaking_assessment_(completed|failed|blocked)"`: mostly `outcome: ok` and
  `completed`.
- The Deepgram console usage grows by roughly the minutes students upload; the OpenRouter usage by one call per marked recording.
- Teachers reporting "Recording uploads are not available right now" means their daily speech-to-text minutes are used up
  (`AUDIO_DAILY_MINUTES_PER_TEACHER`).

## Part D. Turn it off again

1. In the backend `.env`, set `AUDIO_STT_ENABLED=false` (or delete the line). Save.
2. `pm2 restart <backend-app> --update-env`.
3. Check: `https://<your-api-host>/api/audio/config` answers `NOT_FOUND`, the log has no `audio_transcription_worker_started`, and the
   teacher's button says **Create Writing Assignment** again (refresh the page).
4. Nothing is deleted: speaking assignments and recordings stay stored and come back when the flag is turned on again. No new speech-to-text
   or marking cost occurs while it is off.

## Test recordings

Record on a phone with its voice-memo app (M4A) or any recorder that saves MP3, M4A or WAV. Do not record in the browser (Chrome's WebM
recordings are refused because they carry no duration). A 10-second "Hello, this is a test recording for the speaking assignment." is enough
for step 12; for step 13 talk for 30 to 60 seconds about your town.
