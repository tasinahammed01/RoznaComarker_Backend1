# Audio upload and speech-to-text: deployment notes (DRAFT)

Status: draft for review. Backend only, stages 0 to 6. Nothing here is live: the feature is off until `AUDIO_STT_ENABLED=true`.

## Production steps

1. Deploy the backend code.
2. Run `npm ci` in `backend`. The lockfile changed: `music-metadata` 12.3.2 is pinned exactly.
3. Run `npm run migrate:audio-indexes` once. Production connects with automatic index creation off, so the app does not create these
   indexes itself. The script only adds the 8 audio indexes (3 on `audiorecordings`, 5 on `audiousageledgers`). It is safe to run again
   and never drops anything. Stage 6 added `audio_recording_assessment_v1`: run the script again after deploying stage 6.
4. Set the speech-to-text key (`DEEPGRAM_API_KEY`) on the server. Keep it out of the repository.
5. Check that the Nginx body limit allows the upload size: 40 MB by default, plus multipart overhead.
6. Turn the feature on with `AUDIO_STT_ENABLED=true` and restart with PM2. The transcription worker starts only while the flag is on.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `AUDIO_STT_ENABLED` | `false` | Turns the feature on. While off, every `/api/audio` and `/api/speaking` route answers 404, no speaking assignment can be created, and the worker does not start. |
| `AUDIO_MAX_FILE_BYTES` | `41943040` (40 MB) | Largest upload. Allowed range is 1 MB to 50 MB. |
| `AUDIO_MAX_DURATION_SECONDS` | `420` (7 min) | Longest recording, plus 1 s tolerance. Allowed range is 6 to 1800. A speaking assignment can set a lower limit, never a higher one. |
| `AUDIO_DAILY_MINUTES_PER_TEACHER` | `120` | Speech-to-text minutes per owning teacher per UTC day. |
| `AUDIO_MONTHLY_MINUTES_PER_TEACHER` | `1500` | Minutes per owning teacher per UTC month. If set below the daily value, both fall back to their defaults. |
| `AUDIO_STT_PROVIDER` | `deepgram` | Primary provider: `deepgram` or `openai`. |
| `DEEPGRAM_API_KEY` | (none) | Secret. Without it, transcription fails with `AUDIO_STT_NOT_CONFIGURED`. |
| `AUDIO_STT_FALLBACK_ENABLED` | `false` | Opt-in OpenAI fallback. It runs only if this is `true`, `OPENAI_API_KEY` is set, and Deepgram failed with an error worth retrying. Off by default so that the voices of students who may be under 18 never reach a second vendor without a decision. |
| `AUDIO_OPENAI_STT_MODEL` | `gpt-4o-transcribe` | Model used by the fallback. |
| `AUDIO_STT_TIMEOUT_MS` | `300000` | Time limit for one provider call. Allowed range is 10 s to 10 min. |
| `AUDIO_STT_MAX_ATTEMPTS` | `3` | Attempts per recording, from 1 to 3. The waits between attempts are 15 s, 60 s and 5 min. |
| `SPEAKING_UPLOAD_RATE_LIMIT_MAX` | `30` | Uploads per user per 15 minutes. |
| `SPEAKING_MIN_WORDS` | `30` | Fewest words (fillers not counted) a speaking answer needs to be assessed. Allowed range is 5 to 200. Fewer words means "not enough speech to assess", with no AI call and no charge. |
| `SPEAKING_ASSESSMENT_ZDR` | `false` | Opt-in: ask OpenRouter to route the speaking assessor only to zero-data-retention endpoints that do not collect data. Off by default because it can leave no endpoint for the configured model. |

The speaking assessor uses the essay assessment model settings (`ASSESSMENT_AI_MODEL`, `OPENROUTER_API_KEY` and the assessment budgets). It has no settings of its own beyond the two above.

An invalid value is ignored, the default is used, and the variable is reported by name only.

## Behaviour to know

### One transcription in flight per teacher, and per uploading user

- A transcription reserves its minutes before the provider is called.
- Each teacher, and each uploading user, can hold only one reservation at a time. Unique indexes enforce this.
- Why per teacher: it makes the minute cap exact without database transactions. Only one check-and-reserve can happen at a time for a
  teacher.
- It costs nothing today, because the worker runs one transcription at a time in the single PM2 process.
- If several worker processes are ever run, one teacher's class would still be transcribed one recording at a time.
- A recording that finds the slot busy waits 15 s and does not use up an attempt.

### Minute accounting is UTC

- Minutes count on the UTC day and UTC month in which the attempt started.
- The daily cap resets at 00:00 UTC, whatever the server's or the school's time zone.
- A recording that hits the daily cap waits in the queue until the next UTC midnight. It does not use up an attempt.
- Minutes are kept only when a transcript is stored. A failed, cancelled or refused attempt never counts.
- A reservation left by a stopped process stops counting when its lease ends.

### Monthly cap reached: the recording fails

- A recording refused by the monthly cap is marked failed with `AUDIO_MONTHLY_MINUTES_EXCEEDED`. It does not wait silently for up to a
  month.
- The student or teacher can press retry once minutes are available (new month, or a raised cap).
- Uploads are also refused early, with a friendly message, when the teacher's day or month is already used up. This is only a courtesy
  check: the worker's reservation is the real guard.

### WebM files without a duration in the header are refused

- The duration is measured before any provider call. The library (`music-metadata`, also in 12.5.0) reads a WebM duration only from the
  file header.
- Chrome's in-browser recorder (MediaRecorder) writes WebM files with no duration in the header. Those uploads are refused with "We
  couldn't read the length of this recording. Save it as MP3 or M4A and upload it again."
- **In-browser recording must not ship until there is a server-side WebM duration scan.** That scan walks the clusters and block
  timecodes. The alternative is to fix the duration in the browser before upload.
- Uploaded MP3, M4A, Ogg, WAV and WebM files that have a header duration are measured correctly.

### Speaking submissions are kept apart from essays

- A speaking submission is a `Submission` with `sourceKind: 'audio'` and no files. It never gets `ocrStatus`, so the essay recovery worker
  never selects it.
- Its audio, words and transcript live in `AudioRecording`.
- Every essay-only route that takes a submission id answers 404 for it. The list is in `tests/audioGuardInventory.test.js`.
- Playback and download use a private route (`/api/audio/submissions/:id/media` and `/download`). The audio is never served from a
  static folder.

### Replacing a recording

- A student can replace their recording until the due date and until the teacher has marked it.
- The old recording's transcription is cancelled, and its audio and storage are released.

### Storage

- Audio counts against the student's storage quota.
- It is released exactly as charged when the submission is removed or the recording is replaced.

## Speaking assessment (stage 6)

- **When it runs.** A recording is queued for assessment automatically when its transcript is ready. The audio worker runs it right after the transcription sweep.
- **Rubric.** A speaking assignment uses the teacher's own saved rubric. When the teacher picks none, an editable copy of the default
  speaking rubric is created for them once: Task and content 25, Organisation and coherence 20, Grammar 20, Vocabulary 20, Fluency 15.
  Teachers edit it in the saved-rubric library.
- **What the assessor sees.** It receives the assessed text (punctuated, fillers removed, repetitions kept), fluency figures computed by software
  (words per minute, filler rate, pauses over 1 s, repetitions), the task and the rubric. All of it is sent as a data block.
- **How it is scored.** The model picks one level per criterion; the score is computed from those levels. Pronunciation, spelling,
  punctuation and capitalisation are never judged.
- **Credits.** The check uses the same wallet the charge uses: the institution wallet for a class in an institution, otherwise the
  teacher's own. With no credits the assessment is blocked (`INSUFFICIENT_ASSESSMENT_CREDITS`), as for essays.
- **Charging.** One credit is charged only when a result is stored. "Not enough speech", not English, unintelligible, failed or invalid
  results are never charged.
- **Retry.** The owning teacher can retry a failed or blocked assessment: `POST /api/speaking/submissions/:id/retry-assessment`.
- **Results.** `GET /api/speaking/submissions/:id/result` serves the owning student and the owning teacher.
- **Startup log.** The prompt version is logged at startup on a line with `event: speaking_assessment_contract`. It is not part of the
  runtime contract fingerprint.
- **Trial script.** `SPEAKING_TRIAL=call-openrouter node scripts/speakingAssessmentTrial.js` runs the synthetic benchmark against the real
  model with a dev key. It prints scores, tokens and the cost OpenRouter reports. It never runs in tests or in the app.

## Guests on speaking assignments (stage 10)

- A teacher can allow guests on a speaking assignment, as on an essay. Guests use the assignment's guest link and QR code; their recording is
  stored as the teacher's (file, storage and speech-to-text minutes), and the teacher's credits are checked before anything is kept.
- A guest must accept the notice before uploading. Its wording and version live in `src/config/speakingGuestNotice.js`; change the text, change
  the version. The accepted version and time are stored with the submission.
- Both `GUEST_SUBMISSION_ENABLED=true` and `AUDIO_STT_ENABLED=true` are needed; with either off, the guest speaking routes are closed.

### Known limit: one transcription at a time per teacher (accepted for v1)

Every guest recording (and every recording a teacher uploads for a student) is owned by the teacher, and a teacher holds one transcription
reservation at a time (see "One transcription in flight per teacher" above). A class of 30 guests is therefore transcribed one recording after
another: with the default worker, roughly the sum of the 30 provider calls. Students see "Transcribing" until their turn. Accepted for v1;
revisit if classes report long waits.

## Production-safety list (found, not fixed)

| Item | Where | Effect | Status |
|---|---|---|---|
| The essay guest email footer says "© RoznaHub" and links to `support@roznahub.com`; the brand is Rubrilo. | `email.service.js`, `guestEmailHtml` | Guests see another brand in essay emails. The speaking guest emails do not use this footer. | Not fixed (essay email unchanged on purpose). |
| The guest result email is retried every 15 minutes, with no end, when the teacher turns guest access off after a guest's work was marked. | `guestResultNotification.service.js` | One extra query and a warning log line every 15 minutes per such submission; no email is sent. Speaking behaves the same. | Not fixed. |

## Not in this stage

Transcript editing and re-marking, the feedback PDF for speaking, recording in the browser, and replacing a recording as a guest (a second
recording through the guest link is a new submission).
