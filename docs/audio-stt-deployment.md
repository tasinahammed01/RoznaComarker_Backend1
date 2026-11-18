# Audio upload and speech-to-text: deployment notes (DRAFT)

Status: draft for review. Backend only, stages 0 to 5. Nothing here is live: the feature is off until `AUDIO_STT_ENABLED=true`.

## Production steps

1. Deploy the backend code.
2. Run `npm ci` in `backend`. The lockfile changed: `music-metadata` 12.3.2 is pinned exactly.
3. Run `npm run migrate:audio-indexes` once. Production connects with automatic index creation off, so the app does not create these
   indexes itself. The script only adds the 7 audio indexes (2 on `audiorecordings`, 5 on `audiousageledgers`). It is safe to run again
   and never drops anything.
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

## Not in this stage

Assessment and credits, rubric use, guests and the recovery portal, teacher upload on a student's behalf, the frontend, and recording in the
browser.
