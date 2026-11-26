# Speaking Coach: deployment and operation

Speaking Coach gives a student (or a guest, through their private link) two or three short speaking tasks after a speaking result, based on
the weakest rubric areas. The student records an answer for the current task; the coach checks it against that one area, compares it with
the previous attempt and gives short feedback and the next tip. Practice ends when every task is passed, or at the attempt cap.

Practice never changes the assignment grade or the stored result, never charges a credit, and never appears in reports, dashboards,
summaries or PDFs. The teacher sees progress on the speaking submission page.

## 1. What it needs

- `AUDIO_STT_ENABLED=true` (speaking must be on) and `SPEAKING_COACH_ENABLED=true`. Either one off: every coach route answers 404 and the
  pages show no coach.
- The existing assessment model and `OPENROUTER_API_KEY` (no new key). Without them, task wording falls back to templates and practice
  checks fail (the student can retry later).
- The existing speech-to-text provider (no new key).
- Guests: `GUEST_SUBMISSION_ENABLED` as for speaking guests.

## 2. Settings

| Variable | Default | Meaning |
|---|---|---|
| `SPEAKING_COACH_ENABLED` | off | `true` turns the coach on (also needs `AUDIO_STT_ENABLED=true`). |
| `SPEAKING_COACH_PASS_PERCENT` | `70` | 50 to 100. A practised area passes at a level of this percent or above. Copied into each session when it starts, so a change applies to new sessions only. If no level of a criterion falls between this percent and 100 (a three-level rubric: 100, 66.67, 33.33), the second-highest level passes; a two-level criterion passes only at its top level. The teacher card states the rule for each task. |
| `SPEAKING_COACH_MAX_ATTEMPTS_PER_SUBMISSION` | `20` | 1 to 50. Every accepted practice recording counts, except one whose transcription failed for good. At the cap practice ends. |
| `SPEAKING_COACH_MAX_RECORDING_SECONDS` | `90` | 15 to 180. Longest practice recording. |
| `SPEAKING_COACH_MIN_WORDS` | `15` | 5 to 100. Fewer words: "not enough speech", no AI call (the attempt still counts). |
| `SPEAKING_COACH_DAILY_MINUTES_PER_TEACHER` | `30` | Practice speech-to-text minutes per teacher per UTC day. Separate from the graded caps: practice can never use the minutes graded work needs, and graded work never uses these. |
| `SPEAKING_COACH_MONTHLY_MINUTES_PER_TEACHER` | `300` | The same per UTC month. A monthly value below the daily value resets both to the defaults. |
| `SPEAKING_COACH_CHECK_MAX_OUTPUT_TOKENS` | `3000` | 256 to 8000. Output limit of a practice check, thinking included. A reply cut off by the limit is retried once with twice the limit (never above 8000). |
| `SPEAKING_COACH_TASKS_MAX_OUTPUT_TOKENS` | `2500` | 256 to 8000. Output limit of the task wording, thinking included, with the same one retry. |
| `SPEAKING_COACH_REASONING_EFFORT` | `low` | The model's thinking for both calls: `low`, `medium` or `high` (anything else is `low`). |
| `SPEAKING_COACH_UPLOAD_RATE_LIMIT_MAX` | `10` | Practice uploads per student per 15 minutes. Guests: 20 per IP per 15 minutes. |

A value that is not a whole number or is out of range is ignored (the default applies). `SPEAKING_COACH_AI_MAX_OUTPUT_TOKENS` (one limit of
1200 for both calls) is retired and has no effect: at 1200 the model's thinking cut most replies off (section 4).

## 3. Turning it on

1. Deploy the backend with `SPEAKING_COACH_ENABLED` unset.
2. Create the indexes (production connects with autoIndex off): `npm run migrate:speaking-coach-indexes`. It is safe to run twice and
   creates only the Speaking Coach indexes.
3. Deploy the frontend (`npm run build:prod`).
4. Set `SPEAKING_COACH_ENABLED=true`, then `pm2 restart <backend-app> --update-env`.
5. Smoke test with a test class (section 6).

To turn it off: unset it (or `false`) and restart. Sessions and attempts stay stored and come back when it is turned on again.

## 4. Cost

- Speech-to-text: practice recordings use the same provider as graded ones, against the teacher's practice minutes. A 60 to 90 second
  practice answer costs about $0.005 to $0.007 with Deepgram, about $0.004 to $0.006 with Scribe.
- AI, measured (trial on a dev key, `google/gemini-3.8-flash`, before the fix below): about **$0.0035 per successful practice check** and
  about **$0.0035 per task wording** (one per started session).
- What that trial showed: with an output limit of 1200 and the model's default thinking, 2 of 3 practice checks were cut off by the limit
  (`AI_RESPONSE_TRUNCATED`). The successful check used 719 output tokens, 581 of them thinking; the task wording used 1027 of 1200, 932 of
  them thinking. Fix: the coach asks for low thinking (`SPEAKING_COACH_REASONING_EFFORT`), the limits are 3000 (check) and 2500 (wording),
  and a reply that is still cut off is retried once with twice the limit. Re-measure after the fix (section 5).
- A cut-off reply is billed too, so a check that needs its retry costs about two calls. A check that fails (after its retries) gives the
  student's attempt back: it does not count against the cap, and the student sees "try again".
- No credit is charged to the teacher, the student or the guest.
- Typical per submission: one task wording plus about 6 to 9 checks (3 tasks, 2 to 3 tries each), about $0.025 to $0.035.
- Worst case per submission: one task wording plus 20 counted checks, about $0.0035 + 20 × $0.0035 = **about $0.074** when no reply is cut
  off. If every one of them needed its truncation retry, about twice that, **about $0.15**. Failed checks are not counted against the cap, so
  repeated provider failures can add calls beyond these figures; the per-student upload limit (10 per 15 minutes) and the teacher's practice
  minutes bound them.

## 5. Measuring the cost of one practice check (dev key only)

The trial uses the coach's real check prompt and validation on the synthetic benchmark transcripts and makes the calls exactly as the live
coach does: low thinking, the output limits above, and the one retry with twice the limit when a reply is cut off (its cost is counted in the
cap; the line says "retried after truncation at <limit>"). No other retry. It stops once the cost OpenRouter reports reaches the cap. It refuses to run without `--max-cost-usd` (more than 0, at most 5 dollars),
in tests and in production, and never prints a key, the prompt or a provider error text.

```
cd backend
# one practice check, stopped at 5 cents:
SPEAKING_TRIAL=call-openrouter NODE_ENV=development node scripts/speakingAssessmentTrial.js --coach-check --max-cost-usd 0.05
# five checks on different synthetic answers, same cap:
SPEAKING_TRIAL=call-openrouter NODE_ENV=development node scripts/speakingAssessmentTrial.js --coach-check --max 5 --max-cost-usd 0.05
```

It reads `OPENROUTER_API_KEY` and `ASSESSMENT_AI_MODEL` from the environment (or `backend/.env`); use a dev key. Read the "average per
practice check" line. The last call can pass the cap by at most that call's cost.

The cost of task wording (one call per started session) is measured the same way with `--coach-generate`. Both in one run share one cap
(the checks first, then the wording); read "average per practice check" and "average per task wording":

```
SPEAKING_TRIAL=call-openrouter NODE_ENV=development node scripts/speakingAssessmentTrial.js --coach-check --coach-generate --max 3 --max-cost-usd 0.10
```

Worst case per submission: one task wording plus the attempt cap (20) times one practice check (a check that fails is run at most twice).

## 6. Smoke test

1. As a teacher, create a speaking assignment; as a student, upload a recording and wait for the result.
2. On the student's speaking page: "Practice your speaking" shows two or three tasks. Record a task in the browser (allow the microphone),
   upload, wait for the feedback. Never a score or a level.
3. As the teacher, open the student's speaking submission: the practice card shows the tasks, the level reached, pass or not, and the rule.
4. Guests: open a guest result link; accept the practice notice; record a task.
5. The assignment's report and the student's graded result are unchanged.

## 7. What to watch (logs: ids, codes and numbers only)

| Event | Meaning |
|---|---|
| `speaking_coach_session_started` | A session was started: task count and types, `source` (`ai` or `template`), tokens and cost |
| `speaking_coach_attempt_uploaded` | A practice recording was accepted |
| `speaking_coach_attempt_checked` | A practice check: `outcome`, `passed`, tokens, `costUsd` |
| `speaking_coach_check_retry_scheduled` / `speaking_coach_check_failed` | The check failed once / for good (the student can retry it) |
| `speaking_coach_transcription_failed` | A practice transcription failed for good (the attempt was given back) |
| `speaking_coach_minutes_unavailable` | A teacher's practice minutes are used up for now |
| `audio_usage_reserved` / `audio_usage_refused` with `purpose: practice` | Practice minutes |

Warning signs: many `source: template` (the wording model is failing), many `speaking_coach_check_failed`, or a teacher often at
`speaking_coach_minutes_unavailable`.

## 8. Data and privacy

- Practice sessions and attempts are kept in `speakingpracticesessions` and `speakingpracticeattempts`; practice recordings are
  `audiorecordings` with `purpose: practice` and no submission. The audio file of a practice recording is deleted as soon as its transcript
  is stored; the transcript and the feedback stay with the attempt so the teacher can see progress.
- Removing the speaking submission removes its practice (sessions, attempts, practice recordings and any audio left).
- Guests accept a practice notice (its own version, `speaking-coach-guest-2026-11`) before the first practice recording. The graded consent
  is unchanged and stays valid for the graded recording.
- Students and guests never receive a level, a pass flag, a score, the pass rule, or any provider, model, prompt, hash or teacher id.
