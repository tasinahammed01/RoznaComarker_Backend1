# Speaking assignments (audio upload and speech-to-text): deployment guide

Status: ready for review. Backend and frontend, branch `feature/audio-stt`. The feature ships switched **off**: until
`AUDIO_STT_ENABLED=true`, every audio and speaking route answers 404, no speaking assignment can be created, the teacher only sees "Create
Writing Assignment", and the transcription worker does not start. Essays, guests, recovery, teacher uploads, the assignment report and the
feedback PDF are unchanged with the flag off or on.

The step-by-step checks on the server and in the browser are in `docs/audio-stt-smoke-test.md`.

## 1. What the feature does

- A teacher creates a **speaking assignment** (title, due date, task, maximum recording length, show marks, rubric) and can allow guests.
- A student, a guest (through the assignment's link or QR code) or the teacher on a student's behalf uploads **one recording** (MP3, M4A,
  WebM with a duration in its header, Ogg or WAV; up to 40 MB and 7 minutes by default).
- The recording is turned into text by **Deepgram Nova-3**, then **marked by the assessment model** (OpenRouter, the essay assessment model
  settings) against the speaking rubric. One assessment credit is charged only when a result is stored.
- Students, guests and teachers see the recording, the transcript with corrections, the rubric levels, fluency figures computed by software
  and the feedback. Guests and teacher uploads get emails like the essay flows.

## 2. Environment variables

All new variables are optional except the key. An invalid value is ignored, the default is used, and the variable is reported by name only
(never its value).

| Variable | Default | Meaning |
|---|---|---|
| `AUDIO_STT_ENABLED` | off | `true` turns the whole feature on (routes, speaking assignments, the worker). Anything else is off. |
| `DEEPGRAM_API_KEY` | none | **Secret.** The speech-to-text key (with the default provider). Without it every transcription fails with `AUDIO_STT_NOT_CONFIGURED` (no crash). Not needed with `openrouter-scribe`. |
| `AUDIO_STT_PROVIDER` | `deepgram` | Primary provider: `deepgram`, `openai` or `openrouter-scribe` (ElevenLabs Scribe v2 through OpenRouter, section 14). Keep `deepgram` unless you decide otherwise. |
| `OPENROUTER_API_KEY` | none | **Secret.** The backend's existing OpenRouter key (marking uses it). With `openrouter-scribe` it is also the speech-to-text key. |
| `AUDIO_STT_OPENROUTER_MODEL` | `elevenlabs/scribe-v2` | `openrouter-scribe` only: the OpenRouter model id (`author/model`). Anything else is ignored. |
| `AUDIO_STT_OPENROUTER_MAX_FILE_BYTES` | `20971520` (20 MB) | `openrouter-scribe` only: the upload limit becomes the smaller of this and `AUDIO_MAX_FILE_BYTES`. 1 MB to 25,000,000 bytes (OpenRouter refuses multipart uploads over 25 MB and has no other route for Scribe). |
| `AUDIO_STT_FALLBACK_ENABLED` | `false` | Opt-in OpenAI fallback. Runs only if `true`, `OPENAI_API_KEY` is set, and Deepgram failed with an error worth retrying. Off so that the voices of students who may be under 18 never reach a second vendor without a decision. |
| `OPENAI_API_KEY` | none | **Secret.** Used only by the opt-in fallback above. |
| `AUDIO_OPENAI_STT_MODEL` | `gpt-4o-transcribe` | The fallback's model. |
| `AUDIO_MAX_FILE_BYTES` | `41943040` (40 MB) | Largest upload; 1 MB to 50 MB. Nginx must allow it (section 5). |
| `AUDIO_MAX_DURATION_SECONDS` | `420` (7 min) | Longest recording (+1 s tolerance); 6 to 1800. An assignment can set a lower limit, never a higher one. |
| `AUDIO_DAILY_MINUTES_PER_TEACHER` | `120` | Speech-to-text minutes per owning teacher per UTC day. |
| `AUDIO_MONTHLY_MINUTES_PER_TEACHER` | `1500` | Minutes per owning teacher per UTC month. If set below the daily value, both fall back to their defaults. |
| `AUDIO_STT_TIMEOUT_MS` | `300000` | Time limit for one provider call; 10 s to 10 min. |
| `AUDIO_STT_MAX_ATTEMPTS` | `3` | Attempts per recording, 1 to 3. Waits between attempts: 15 s, 60 s, 5 min. |
| `SPEAKING_UPLOAD_RATE_LIMIT_MAX` | `30` | Student uploads per user per 15 minutes. |
| `SPEAKING_MIN_WORDS` | `30` | Fewest words (fillers not counted) to be marked; 5 to 200. Fewer: "not enough speech", no AI call, no charge. |
| `SPEAKING_OFF_TOPIC_SCORE_CAP` | `50` | When the answer is off topic (and the rubric has the task criterion), the overall score is capped here; 0 to 100. |
| `SPEAKING_ASSESSMENT_ZDR` | `false` | Opt-in: route the speaking assessor only to zero-data-retention endpoints on OpenRouter. Can leave no endpoint for the model. |
| `TEACHER_UPLOAD_RATE_LIMIT_MAX` | `400` | Shared with the essay teacher upload: uploads per teacher per 10 minutes. |
| `TEACHER_UPLOAD_SEND_RATE_LIMIT_MAX` | `60` | Shared with the essay teacher upload: Send/Resend per teacher per 10 minutes. |

Also used, unchanged: `OPENROUTER_API_KEY`, `ASSESSMENT_AI_MODEL` and the assessment budgets (marking), `GUEST_SUBMISSION_ENABLED` (guests,
for essays and speaking), `UPLOAD_BASE_PATH` (recordings live in `<UPLOAD_BASE_PATH>/audio`), `FRONTEND_URL` (links in emails), the SMTP
settings (emails).

The guest notice (its text and version) is not an environment variable: it is in `src/config/speakingGuestNotice.js`. Change the text,
change the version.

## 3. Enabling order (production)

Do the steps in this order. Steps 1 to 5 change nothing for users: the flag is still off.

1. **Deploy the backend code** with `AUDIO_STT_ENABLED` unset (or `false`).
2. **Install exactly the locked packages:** `npm ci` in `backend`. The lockfile pins `music-metadata` 12.3.2 (needs Node 22 or newer: check
   with `node --version`).
3. **Create the audio indexes once:** `npm run migrate:audio-indexes`. Production connects with automatic index creation off, so the app does
   not create these itself. The script only adds the audio indexes on `audiorecordings` and `audiousageledgers`, is safe to run again, and
   never drops anything.
4. **Set the keys** in the backend `.env` on the server: `DEEPGRAM_API_KEY` (and nothing for the fallback unless you decide to use it). Keep
   keys out of the repository.
5. **Restart with the new environment:** `pm2 restart <backend-app> --update-env`, then check the log for a normal start (section 7).
6. **Deploy the frontend** (`npm run build:prod`, as always). With the flag off it looks exactly as before.
7. **Smoke test with the flag off** (`docs/audio-stt-smoke-test.md`, part A): essays, guests, recovery and the PDF as before; the audio
   routes answer 404.
8. **Turn it on:** set `AUDIO_STT_ENABLED=true`, then `pm2 restart <backend-app> --update-env`. Run the smoke test part B (a 10-second
   recording end to end).

## 4. One PM2 instance only

Run the backend as **one** PM2 process (fork mode, `instances: 1`), as today.

- The transcription and marking worker runs **inside** the backend process (started with the flag). Several instances would run several
  workers. They are safe against double work (leases), but the per-teacher minute reservation then queues them anyway.
- The rate limiters keep their counts **in memory**. With several instances each would have its own counts and every limit would be
  multiplied by the number of instances.

## 5. Nginx and proxy settings

The default upload limit is 40 MB (`AUDIO_MAX_FILE_BYTES`). Check the server block that proxies `/api`:

- `client_max_body_size 45m;` (40 MB plus multipart overhead; raise it with `AUDIO_MAX_FILE_BYTES`). The essay uploads need far less, so this
  only raises the ceiling.
- `proxy_read_timeout 120s;` and `proxy_send_timeout 120s;` (or more): a 40 MB upload on a slow school connection can take over a minute.
  The transcription itself runs in the background and never holds a request open.
- `proxy_request_buffering on;` (the Nginx default) is fine.
- Keep `X-Forwarded-For` set: production trusts one proxy (`trust proxy 1`), and the per-IP limits on guest routes use the real address.

## 6. Cost controls and expected cost

- **Speech-to-text (Deepgram Nova-3, pre-recorded):** billed per audio minute. Deepgram's pricing page lists Nova-3 pre-recorded at about
  $0.0048 per minute on pay-as-you-go (older Deepgram pages say $0.0043); confirm the current price in your Deepgram console. A 3-minute
  answer costs about **1.5 cents**, a 7-minute answer about 3.5 cents. A failed or refused attempt is not counted against the teacher's
  minutes; retries can be billed by Deepgram.
- **Marking (OpenRouter, the essay assessment model):** one call per recording that has enough speech, about 2,400 input and 900 output
  tokens for a 2 to 3 minute answer. Check the real cost with the trial script on a dev key:
  `SPEAKING_TRIAL=call-openrouter node scripts/speakingAssessmentTrial.js` (prints tokens and the cost OpenRouter reports).
- **Credits:** one assessment credit per stored result, from the same wallet as essays. "Not enough speech", not English or unintelligible
  answers, and failed runs are never charged.
- **Caps:** `AUDIO_DAILY_MINUTES_PER_TEACHER` (120) and `AUDIO_MONTHLY_MINUTES_PER_TEACHER` (1500) cap speech-to-text per teacher. Worst
  case per teacher: 1500 minutes a month, about $7 of speech-to-text. Uploads are refused early with a friendly message when a teacher's
  minutes are used up.
- **Set a budget alert in the Deepgram console** (and keep the OpenRouter credit limit) as the outer guard.

## 7. Logs: what to grep and what healthy looks like

Logs carry ids, codes, counts and durations only: never transcript text, audio, file names, emails, names, keys or provider response
bodies.

| Event | Meaning | Healthy |
|---|---|---|
| `audio_stt_attempt` | One provider call: `provider`, `outcome` (`ok`/`failed`), `code`, `durationMs`, `audioBytes`, `wordCount` | Mostly `outcome: ok`; `durationMs` a few seconds per minute of audio |
| `audio_transcription_worker_started` | The worker started (only with the flag on) | Once per start |
| `audio_transcription_claimed` / `_ready` / `_deferred` | Worker steps for one recording | `ready` follows each upload within a minute or two |
| `audio_usage_reserved` / `_refused` / `_busy` | Minutes reserved before a provider call / refused by a cap / another transcription of the same teacher running | Mostly `reserved`; `busy` while a class uploads |
| `audio_upload_rejected` | An upload refused by the checks: `code`, `status` | Occasional `AUDIO_TOO_SHORT`, `AUDIO_TYPE_*` |
| `audio_upload_minutes_unavailable` | A teacher's minutes are used up (upload refused early) | Rare; frequent means the caps are too low |
| `speaking_assessment_completed` | Marking stored: `overallScore`, tokens, `costUsd`, `charged` | One per marked recording, `charged: true` |
| `speaking_assessment_not_assessable` / `_blocked` / `_failed` | Not enough speech / no credits / a failed run (with `code`) | Few; `_blocked` means a teacher is out of credits |
| `speaking_assessment_contract` | At startup: the speaking prompt and schema versions | Once per start |
| `speaking_guest_submission_created`, `speaking_teacher_upload_saved` | A guest upload / a teacher upload saved | One per upload |
| `teacher_upload_email_sent` / `_not_sent` | Feedback emails for teacher uploads (essay and speaking) | `sent` after marking |
| `audio_stt_provider_usage` | `openrouter-scribe` only: `seconds` and `costUsd` OpenRouter reported for one call | One per call; about $0.0000611 per second |
| `audio_stt_unreliable_result` | `openrouter-scribe` only: an answer failed the check; `retry` (`first`/`second`), `reasons` (codes) and `metrics` (numbers) | Rare; `second` means the recording failed with `AUDIO_STT_UNRELIABLE_RESULT` |
| `audio_stt_provider_credits` (warning) | `openrouter-scribe` only: OpenRouter answered 402 (credits or in-flight budget); retried after `Retry-After` | Never; top up or raise the key's budget |

Grep, for example: `pm2 logs <backend-app> --lines 2000 | grep -E "audio_stt_attempt|speaking_assessment_(completed|failed|blocked)"`.

Warning signs: `audio_stt_attempt` with `code: AUDIO_STT_NOT_CONFIGURED` (key missing), `AUDIO_STT_REJECTED` with `httpStatus` 401 or 403 (key wrong or out of balance), many
`AUDIO_STT_TIMEOUT`, `audio_transcription_sweep_failed`, or `AUDIO_DURATION_UNAVAILABLE` refusals (the duration library failed to load:
check the Node version).

## 8. How it behaves (good to know)

- **One transcription at a time per teacher (known limit, accepted for v1).** A transcription reserves its minutes before the provider is
  called, and each teacher (and each uploading user) holds one reservation at a time, enforced by unique indexes. Every guest recording and
  every recording a teacher uploads belongs to the teacher, so a class of 30 guests is transcribed one after another: students see
  "Transcribing" until their turn. A recording that finds the slot busy waits 15 s without using an attempt.
- **Minutes count in UTC.** The daily cap resets at 00:00 UTC. A recording that hits the daily cap waits for the next UTC day; one refused
  by the monthly cap fails with `AUDIO_MONTHLY_MINUTES_EXCEEDED` and can be retried once minutes are available.
- **Speaking work is kept apart from essays.** A speaking submission is a `Submission` with `sourceKind: 'audio'`; its audio, words and
  transcript live in `AudioRecording`. Every essay-only route answers 404 for it (`tests/audioGuardInventory.test.js`). Essay numbers,
  reports and the assignment report leave speaking out.
- **Private audio.** Playback and download go through signed routes (`/api/audio/submissions/:id/media`, `/download`, and
  `/api/guest/speaking/submissions/:id/media` for a guest's own recording): owner only, `Cache-Control: private, no-store`,
  `X-Content-Type-Options: nosniff`, the content type measured at upload. Never a static folder.
- **Replacing.** A student can replace their recording until the due date and until it is marked; a teacher can replace one they uploaded.
  The old recording's transcription is cancelled and its file and storage are released.
- **Storage** is charged to the uploader: the student for their own recording, the teacher for teacher uploads and guest recordings. It is
  released exactly as charged on replace and removal.
- **Guests** need both `GUEST_SUBMISSION_ENABLED=true` and the flag, and the teacher must allow guests on the assignment. A guest accepts the
  notice before uploading; the accepted version and time are stored with the submission.

## 9. Known limits

- One transcription at a time per teacher (above).
- A guest cannot replace a recording: a second recording through the link is a new submission.
- No transcript editing or re-marking (stage 8, postponed).
- In-browser recording is not supported. Chrome's recorder writes WebM files with no duration in the header, and those are refused ("We
  couldn't read the length of this recording. Save it as MP3 or M4A and upload it again."). In-browser recording must not ship until there is
  a server-side WebM duration scan.
- Guest uploads are limited to 10 per 15 minutes per IP address (the essay guest value). A class on one school connection shares one
  address: more than 10 guests uploading within 15 minutes are asked to wait.

## 10. Production-safety list (found, not fixed)

| Item | Where | Effect | Status |
|---|---|---|---|
| The essay guest email footer says "© RoznaHub" and links to `support@roznahub.com`; the brand is Rubrilo. | `email.service.js`, `guestEmailHtml` | Guests see another brand in essay emails. The speaking guest emails do not use this footer. | Not fixed (essay email unchanged on purpose). |
| The guest result email is retried every 15 minutes, with no end, when the teacher turns guest access off after a guest's work was marked. | `guestResultNotification.service.js` | One extra query and a warning log line every 15 minutes per such submission; no email is sent. Speaking behaves the same. | Not fixed. |
| Guest uploads (essay and speaking) are limited to 10 per 15 minutes per IP, fixed in code. | `guestSubmission.routes.js`, `speakingGuest.routes.js` | A class sharing one school IP can be asked to wait. | Not fixed; a candidate for a configurable limit. |
| The playback route has no limit of its own (the global per-IP and per-user limits apply). | `audio.routes.js` | Repeated seeking in a long recording is served normally; bandwidth only. | Not fixed (low). |

## 11. Storage audit (read-only)

`npm run audit:audio-storage` (from the backend folder on the server) lists audio files that no recording uses and recordings whose file is
missing. It deletes and changes nothing. `-- --json` prints the whole report. Files changed in the last 10 minutes are skipped (an upload in
progress). Run it after launch and from time to time; report anything it lists before deleting files by hand.

## 12. Rollback

- **Fastest (no deploy):** set `AUDIO_STT_ENABLED=false` (or remove it) and `pm2 restart <backend-app> --update-env`. Every audio and speaking
  route answers 404 at once, the worker stops, no new transcription or marking cost occurs, and the teacher sees only writing assignments.
  Existing speaking data stays in the database and on disk, untouched, and comes back when the flag is turned on again.
- **Code rollback:** redeploy the previous backend and frontend builds. The audio indexes and collections (`audiorecordings`,
  `audiousageledgers`) are harmless to the old code and can stay. Speaking submissions are `Submission` documents with
  `sourceKind: 'audio'`; the old code does not know them, so turn the flag off first and leave them in place (do not delete them by hand).
- Keys can stay in `.env`; nothing reads them while the flag is off.
- **OpenRouter Scribe back to Deepgram:** set `AUDIO_STT_PROVIDER=deepgram` (or remove it), make sure `DEEPGRAM_API_KEY` is set, and
  `pm2 restart <backend-app> --update-env`. Recordings already transcribed keep their transcript; queued ones use Deepgram from the next attempt.

## 13. Speaking assessment details

- **When it runs.** A recording is queued for marking when its transcript is ready; the worker runs it right after the transcription sweep.
- **Rubric.** The teacher's saved rubric, or (when none is chosen) an editable copy of the default speaking rubric created once per teacher:
  Task and content 25, Organisation and coherence 20, Grammar 20, Vocabulary 20, Fluency 15.
- **What the assessor sees.** The assessed text (punctuated, fillers removed), the fluency figures, the task and the rubric, sent as a data
  block. Pronunciation, spelling, punctuation and capitalisation are never judged.
- **Scoring.** The model picks one level per criterion; the score is computed from those levels; the off-topic cap applies after.
- **Retry.** The owning teacher can retry a failed or blocked assessment. A "not enough speech" or not-English recording is not retried: a
  new recording is the way forward.
- **Startup log.** `speaking_assessment_contract` carries the prompt version. It is not part of the runtime contract fingerprint (the essay
  fingerprint is unchanged by this feature).

## 14. Optional provider: ElevenLabs Scribe v2 through OpenRouter (`openrouter-scribe`)

Deepgram stays the default. Scribe is used only when `AUDIO_STT_PROVIDER=openrouter-scribe` is set; then no Deepgram key is needed.

- **Switching on:** set `AUDIO_STT_PROVIDER=openrouter-scribe` (the backend's existing `OPENROUTER_API_KEY` is used), then
  `pm2 restart <backend-app> --update-env`. Optional: `AUDIO_STT_OPENROUTER_MODEL`, `AUDIO_STT_OPENROUTER_MAX_FILE_BYTES` (section 2).
- **Key budget (advised):** the OpenRouter key is shared with marking. Set a credit limit on the key in the OpenRouter dashboard and keep an eye
  on `audio_stt_provider_credits` warnings: a 402 (out of credit, or too many requests in flight for the balance) is retried after its
  `Retry-After` and is never shown to a student as their problem, but recordings wait until credit is available.
- **What is sent:** one multipart request per call to `https://openrouter.ai/api/v1/audio/transcriptions` (fixed; `OPENROUTER_BASE_URL` does not
  apply): model, the recording (named `audio.<ext>`, never the original name), `verbose_json`, word and segment timings, English, and
  `provider: { zdr: true, allow_fallbacks: false }` (zero data retention, no silent re-routing). If OpenRouter has no zero-retention endpoint
  for the model it answers 404 at "Filter by Data Policy"; that is reported as `AUDIO_STT_NOT_CONFIGURED`.
- **Limits:** uploads are refused above min(`AUDIO_MAX_FILE_BYTES`, `AUDIO_STT_OPENROUTER_MAX_FILE_BYTES`) = 20 MB by default, with the usual
  "too large" message (the 7-minute limit is unchanged). A larger file reaching the provider (for example after the cap was lowered) fails with
  `AUDIO_STT_FILE_TOO_LARGE_FOR_PROVIDER`; OpenRouter's own 400 "exceeds the 25 MB multipart upload limit" maps to the same code. Nothing is
  re-encoded. A 7-minute recording is about 7 MB as 128 kbps M4A or MP3, 10 MB at 192 kbps, and 13 MB as 16 kHz mono WAV; CD-quality WAV
  (44.1 kHz stereo) passes 20 MB after about 2 minutes, so such a file is refused at upload with the "too large" message.
- **Cost:** about $0.0000611 per second ($0.026 for 7 minutes), reported per call in `audio_stt_provider_usage`. A suspicious answer is asked
  for again once, so that recording can cost twice; the teacher's minutes are counted once per attempt.
- **What is stored:** the same transcript schema as Deepgram (provider `openrouter-scribe`, model, the OpenRouter generation id as request id,
  words with plain and punctuated text, per-word confidence, utterances derived from sentence ends and gaps of 1 s or more, times clamped to
  the file length). Provider and model live in the raw transcript only (server side); no student, guest or teacher payload carries them.
- **Fillers:** Scribe keeps "um", "uh", "mm", "hmm", "er"... The filler set used by the fluency figures includes them
  (`audio-fluency-v2`, `audio-derived-text-v2`). Results stored before keep their v1 figures. Measured: filler spelling and count can differ
  slightly between two runs of the same file ("mm" / "um" / "uh"); the rest of the text was identical.

### The suspicious-response check (`services/audio/stt/transcriptGuard.js`)

Scribe was measured to sometimes return text squashed into zero-length words with duplicated text, or to lose a stretch silently while later
words are still timed up to the end. Every Scribe answer is checked against our own duration scan before it is stored:

| Check (reason code) | Fails when | Real speech measured | Failures measured |
|---|---|---|---|
| `ZERO_LENGTH_RUN` / `ZERO_LENGTH_SHARE` | 10 zero-length words in a row, or over 2% (and at least 5) | 0 | 131 words, a run of 89 |
| `WORDS_BEYOND_DURATION` | a word ends more than 1 s after the end of the audio | 0 | 0 |
| `OVERLAPPING_WORDS` | over 1% (and at least 3) overlapping word pairs | 0 | 0 |
| `DUPLICATED_BLOCK` | 20+ words twice in a row, one copy in under half the time of the other | longest plain repeat 387 words, same pace | 266 and 133 words |
| `END_GAP` | speech ends more than 15 s before the end of the audio | at most 1.33 s | 6.3 s and 0.04 s |
| `DURATION_MISMATCH` | the provider heard a length that differs from ours by more than 2 s and 5% | 0 s | 0 s |
| `RATE_DROPOUT` / `RATE_BURST` | a 30 s window under 0.2x / over 2x the median speaking rate (60 s of speech or more) | 0.82x to 1.54x | 0.06x; 2.55x |

Calibration: speaking-A (45 s), speaking-B (142 s) and two runs of a 417 s real-speech file pass; both looped-speech failures fail
(`tests/fixtures/audio/openrouter-scribe`, `tests/audioSttGuard.test.js`).

- **Behaviour:** a suspicious answer is requested once more, inside the same attempt. If the second answer is also suspicious, the recording
  fails with `AUDIO_STT_UNRELIABLE_RESULT`: no transcript is stored, no minutes and no credit are charged, no assessment runs, the student
  sees the usual "could not be turned into text" state and can record again (or the teacher can retry). Logs carry reason codes and numbers
  only (`audio_stt_unreliable_result`).
- **Limits of a transcript-only check:** a student who is silent for 30 s or more in the middle of an answer, or who stops talking more than
  15 s before ending the recording, looks like a dropout and is asked to record again. There is no audio energy check on the server.
- **Manual test (development only):** `AUDIO_STT_GUARD_FORCE_SUSPICIOUS=true` makes every Scribe answer fail the check (reason
  `FORCED_FOR_TESTING`). It is honoured only when `NODE_ENV` is `development` or `test`; in production, staging or with `NODE_ENV` unset it is
  ignored.
