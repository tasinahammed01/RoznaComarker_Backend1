# Release Candidate 3 - deploy runbook (Linux VPS, PM2, Nginx/CloudPanel)

These files keep the `docs/release-rc1/` path they were brought from. **RC3 is the release these files now describe:** backend branch `release-candidate-3`, frontend branch `highlight-sync`. RC3 is RC2 plus the Gemini reader and the line-by-line word boxes. The rollback for transcription is RC2's Qwen reader, on the same code, by the env change below.

## RC3: what changes from RC2

**Reader settings. Model and reader go together; any other pair stops the server.**

| Setup | `OCR_GPT_VISION_MODEL` | `OCR_GPT_VISION_READER` |
|---|---|---|
| Gemini (RC3 default) | `google/gemini-3.8-flash` | `verbatim_json` |
| Qwen (fallback) | `qwen/qwen3.8-27b` | `json_contract` (or `plain_text`) |

- `OCR_SOURCE_MODE=gpt_vision_exact` and `OCR_GPT_VISION_MODEL` **must be set**: in production a missing one stops startup with `OCR_SOURCE_CONFIGURATION_INVALID`. RC2 started silently on a default.
- `OPENROUTER_API_KEY` and `GOOGLE_APPLICATION_CREDENTIALS` are required. Gemini reads through OpenRouter; word boxes come from Google Vision.
- Optional: `OCR_GPT_VISION_REASONING` (leave at the default `low`: `medium` measured 37 to 108 seconds per page against about 5, and one read timed out), `OCR_GPT_VISION_TEMPERATURE` (default 0), `OCR_GPT_VISION_SECOND_READER` (default off: it only flags words, about half of its flags were false, and it does not recover a lost line).
- `AI_FALLBACK_n_MODEL` with provider `openrouter` needs the provider prefix, for example `google/gemini-3.6-flash`. The server starts without it, and the fallback then fails when it is needed.

**Check for duplicate keys in `.env`.** The last occurrence of a key wins, so an old line further down silently overrides the one you just changed. The check in step 1 lists them. Remove them before starting.

**Student data.** Page images go to Google AI Studio through OpenRouter, and to Google Vision.

Everything below was written for RC2 and still applies unless this section says otherwise. Nothing here has been run on production. Replace `BACKEND_DIR`, `FRONTEND_DIR` and `APP_USER` with the real values. Steps marked **(unverified)** depend on the VPS, which could not be reached when this was written.

## RC3, final changes (Task 17)

- **Image markers:** underlines and chips have the colour of their error type, a chip sits on its own word, and a line is exactly the word's box. The PDF uses the same rules.
- **Correction Statistics:** every row shows only the whole number of corrections the viewer sees, with the codes that make it up ("SP 4 · P 2 · CAP 2"); no rubric fraction and no "Holistic" anywhere. Rubric scores stay in the score panel and the Detailed Feedback cards. Results stored earlier are shown with the same wording when they are read; nothing in the database changes.
- **Scores:** the rubric no longer receives Content or Organization findings, so they cannot move a score. The formula is unchanged.
- **Runtime contract fingerprint:** unchanged. The correction prompt, the rubric prompt and the schemas are the same as before Task 17.
- **PDF cache:** the PDF renderer files changed, so every report is generated again on its first download after the deploy (a few seconds each). Nothing to run.
- **Image markers (Task 18):** lines, rails and brackets are 2px with a 0.5px dark halo.
- **Results page (Task 18):** while the assessment that saved a provisional score is still running, the page keeps waiting and then shows the final score and detailed feedback without a reload. After 3 minutes of waiting it offers Reload.
- **Adaptive practice (Task 18):** becomes available by itself when the final evaluation matches the corrections; no teacher action is needed. Practice items are still generated only when the student clicks.
- **New environment variables:** none.

## RC3, final changes (Tasks 20 to 22)

- **Corrections are more reliable (Task 20).** A malformed correction reply gets one more attempt with different sampling, inside the same time budget. A single over-long finding is left out instead of rejecting the whole reply (this was the cause of a reproducible failure). Measured on 3 essays x 30 runs with the real model: failures 30/90 before, 0/90 after, no added time on these essays.
- **If the correction step still fails,** one automatic retry of that step alone runs 10 seconds later, and the student, the guest and the teacher get a "Retry analysis" (teacher: "Retry corrections") button, at most 3 times per submission. These retries never re-score and never use an Assessment Credit. The teacher's full "Regenerate" is unchanged: it checks and uses a credit, as before. When corrections arrive after the score, the score card says once: "The score was calculated before the detailed corrections were available."
- **Database:** submissions get a `correctionRetry` sub-document (the state of that retry). No index, no migration. The recovery worker never picks it up.
- **Image markers (Task 21):** a sentence-level correction (FRAG, RO, Content/Organization codes, or a quote of more than four words) is one bracket in the margin from its first to its last line, instead of one long underline per line. Overlapping brackets get separate columns; a bracket that needs the right margin opens towards the text. Word-level underlines are unchanged (0 of 860 on the development database changed). On a phone, chips are smaller (16px) and lines thicker (3px). The PDF uses the same rules; the PDF cache regenerates again on first download.
- **Student pages (Task 22):** "Submit Another Draft" is an outlined button with "View Submission". A failed correction step shows one message with the retry button, not four contradicting ones. The date under the essay title is the date of the draft being viewed (it was the assignment's date).
- **Runtime contract fingerprint:** the correction and rubric prompt and schema versions are unchanged.
- **New environment variables:** none.

## The deploy, in order (VPS)

**Before you start, on the developer's machine:** the final RC3 commit must be on GitHub. The final freeze (Task 22) found `origin/release-candidate-3` at `84d584ea`, 8 commits behind the final local commit (this document's commit included), and `origin/highlight-sync` at `a6251cf`, 14 behind. Push both branches first, then compare the commit below with the one you were given.

**Never switch the `.env` to Gemini before the new code is merged.** The code on production (`45e49aae`) refuses `OCR_GPT_VISION_MODEL=google/gemini-3.8-flash` and the server would not start. The new code accepts the current Qwen settings, so the code goes first and the env second.

```
cd BACKEND_DIR

# 1. Backup (Atlas snapshot first, note its name)
TS=$(date +%Y%m%d-%H%M%S); BK=~/backups/rc3-$TS; mkdir -p "$BK"; chmod 700 "$BK"
git rev-parse HEAD > "$BK/backend.commit"
cp .env "$BK/backend.env"; chmod 600 "$BK/backend.env"
tar -czf "$BK/frontend-dist.tgz" -C FRONTEND_DIR dist

# 2. Code: fast-forward only (RC3 contains origin/main; nothing on the server is lost)
git status --short | grep -v ' node_modules/'           # must print nothing
git fetch origin release-candidate-3
git merge --ff-only FETCH_HEAD
git log -1 --format='%h %s'                              # must be the RC3 commit you were given

# 3. Env, only now. Duplicate keys first: the last one wins.
grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' .env | sort | uniq -d    # remove every duplicate this prints, keeping one line
#   then set (one line each, edit with nano):
#   OCR_SOURCE_MODE=gpt_vision_exact
#   OCR_GPT_VISION_MODEL=google/gemini-3.8-flash
#   OCR_GPT_VISION_READER=verbatim_json
#   HEALTH_DETAIL_TOKEN=<output of: openssl rand -hex 32>
#   APP_DEPLOYMENT_REVISION=<the short commit hash from step 2>
#   then run the startup check in section 1; it must report no fatal line.

# 4. Migrations (see section 4 for what each does)
npm run migrate:recovery-portal-indexes     # applies (no dry run); safe to repeat
npm run migrate:annotation-indexes          # applies (no dry run); safe to repeat
npm run report:score-review                 # read-only counts
npm run migrate:teacher-annotations         # dry run; apply only if it reports overlays to convert

# 5. Restart and look
pm2 restart RoznaComarker_Backend --update-env
pm2 logs RoznaComarker_Backend --lines 100 --nostream

# 6. Verify
TOKEN=$(grep -E '^HEALTH_DETAIL_TOKEN=' .env | cut -d= -f2-)
HEALTH_DETAIL_TOKEN="$TOKEN" RUNTIME_HEALTH_URL=https://comarkerback.roznahub.com/api/health npm run verify:runtime; unset TOKEN
#   upload the frontend build (section 5), then the curl checks in section 6

# 7. Smoke tests: MANUAL_QA_CHECKLIST.md on a test account, never a real student's work.

# 8. Guest submission, last: set GUEST_SUBMISSION_ENABLED=true, then pm2 restart RoznaComarker_Backend --update-env.
#    Rollback of this step alone: set it to false and restart the same way.
```

**Rollback** (also section 7):

```
cd BACKEND_DIR
cp "$BK/backend.env" .env                          # first: the old code refuses the Gemini settings
git reset --keep "$(cat "$BK/backend.commit")"     # --keep, never --hard: the modified node_modules files stay
pm2 restart RoznaComarker_Backend --update-env
tar -xzf "$BK/frontend-dist.tgz" -C FRONTEND_DIR    # frontend: the dist backup
```

The rehearsal of this sequence used a throwaway database; the commands themselves were not run on the VPS.

## 0. Which commit is production on?

```
cd BACKEND_DIR && git rev-parse HEAD && git status --short | wc -l && git status --short | grep -c node_modules
cd FRONTEND_DIR && git rev-parse HEAD
pm2 list
```

| Backend commit on the VPS | What it means |
|---|---|
| `45e49aae` (`origin/main`) | No teacher overlay can exist in the database (the code has no `teacherAnnotations`). The data migration is not needed. Rollback target: this commit. |
| `a64520dc` (`origin/ocr-verbatim-hardening`) | Contains the OCR reader work, version 1 teacher overlays and the production startup guard. Version 1 overlays may exist. Check `OCR_GPT_VISION_MODEL` (step 1). Rollback target: this commit. |
| Anything else | Stop. Work out what is deployed before going on. |

If `git status` shows changes under `node_modules` (it is tracked in this repo), `git checkout` may refuse. Do **not** run `git reset --hard`: stop and decide first.

**Baseline decision.** Find the row for what step 1 and step 4 will show. Boots below were run with fake values in `NODE_ENV=production`, except where marked.

| Condition | `45e49aae` (`origin/main`) | `a64520dc` (`origin/ocr-verbatim-hardening`) | RC2 | What to do when moving to RC2 |
|---|---|---|---|---|
| `AI_PRIMARY_PROVIDER` / `AI_PRIMARY_MODEL` missing | stops | stops | stops | Nothing new. Set them if step 1 says missing. |
| Flashcard indexes missing | stops | stops | stops | Nothing new. Step 4 prerequisite. |
| `OCR_SOURCE_MODE` missing | starts, `legacy` | stops (`OCR_SOURCE_CONFIGURATION_INVALID`) | starts, `legacy` | Coming from `a64520dc`, the guard is gone: a later mistake is silent. Confirm the value in `.env`. |
| `OCR_GPT_VISION_MODEL` missing (`gpt_vision_exact`) | starts, `openai/gpt-5.6-sol` | stops | starts, `openai/gpt-5.6-sol` | Same. |
| `OCR_GPT_VISION_MODEL=google/gemini-3.8-flash` | stops | accepted only with the `verbatim_json` reader setting (read in code; without that setting the boot stopped) | stops | Coming from `a64520dc` on Gemini: change the model **before** the restart, or RC2 will not start. |
| Teacher overlays version 1 in the database | cannot exist | may exist | migration available | Dry run in step 4. |
| Recovery and annotation indexes | code does not exist | code does not exist | used, not required to start | Run both migrations in step 4. |
| Guest submission indexes | required by guest upload (read in code; the check has no diff from RC2) | not checked; same script present | required by guest upload (run) | Step 4 prerequisite. |

## 1. Environment

Run the check below on the VPS. It prints variable names and true or false, never a value, and changes nothing. Do not paste its output anywhere with values added.

```
cd BACKEND_DIR
bash <<'RC2CHECK'
# RC2 startup check. Read-only. Run in the backend folder. Prints variable NAMES and true/false only, never a value.
set +x; ENVF="${ENVF:-.env}"; [ -r "$ENVF" ] || { echo "cannot read $ENVF"; exit 1; }
NAMES=$(grep -E '^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=' "$ENVF" | cut -d= -f1 | sed -E 's/^[[:space:]]*(export[[:space:]]+)?//; s/[[:space:]]+$//')
has() { printf '%s\n' "$NAMES" | grep -qx "$1"; }
# True when the last line for the name has nothing after '=' except quotes. The value is matched, never printed.
empty() { grep -E "^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=" "$ENVF" | tail -1 | grep -qE "=[[:space:]]*(\"\"|'')?[[:space:]]*$"; }
state() { if ! has "$1"; then echo MISSING; elif empty "$1"; then echo EMPTY; else echo PRESENT; fi; }
ok() { [ "$(state "$1")" = PRESENT ]; }
# Only ever called for the non-secret names below.
val() { grep -E "^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=" "$ENVF" | tail -1 | cut -d= -f2- | sed -E "s/^[[:space:]]+//; s/[[:space:]]+#.*$//; s/[[:space:]]+$//; s/^[\"']//; s/[\"']$//"; }
tf() { if "$@"; then echo true; else echo false; fi; }
FATAL=0
fatal() { s=$(state "$1"); printf '%-44s %-8s %s\n' "$1" "$s" "$([ "$s" = PRESENT ] && echo ok || echo 'FATAL: server will not start')"; [ "$s" = PRESENT ] || FATAL=$((FATAL+1)); }
either() { if ok "$1" || ok "$2"; then printf '%-44s %-8s ok\n' "$1 or $2" PRESENT; else printf '%-44s %-8s FATAL: server will not start\n' "$1 or $2" MISSING; FATAL=$((FATAL+1)); fi; }
opt() { s=$(state "$1"); printf '%-44s %-8s %s\n' "$1" "$s" "$([ "$s" = PRESENT ] && echo ok || echo "$2")"; }
check() { r=$(tf eval "$2"); printf '%-44s %s\n' "$1" "$r"; [ "$r" = true ] || { [ "$3" = fatal ] && { FATAL=$((FATAL+1)); echo "    ^ FATAL: server will not start"; }; }; }
echo "=== always required"
for n in NODE_ENV PORT MONGO_URI JWT_SECRET FRONTEND_URL PUBLIC_API_URL BASE_URL FIREBASE_PROJECT_ID FIREBASE_CLIENT_EMAIL FIREBASE_PRIVATE_KEY GOOGLE_APPLICATION_CREDENTIALS PAYMENT_PROVIDER PAYPAL_ENV AI_PRIMARY_PROVIDER AI_PRIMARY_MODEL OPENROUTER_API_KEY; do fatal "$n"; done
either CORS_ALLOWED_ORIGINS CORS_ORIGINS
echo "=== PayPal, for the selected PAYPAL_ENV"
PE=$(val PAYPAL_ENV | tr '[:lower:]' '[:upper:]'); [ -n "$PE" ] || PE=SANDBOX
fatal "PAYPAL_${PE}_CLIENT_ID"; fatal "PAYPAL_${PE}_CLIENT_SECRET"
if [ "$PE" = SANDBOX ]; then
  either PAYPAL_SANDBOX_WEBHOOK_ID PAYPAL_WEBHOOK_ID; either PAYPAL_SANDBOX_PRODUCT_ID PAYPAL_PRODUCT_ID
  either PAYPAL_SANDBOX_PLAN_ESSENTIAL_MONTHLY PAYPAL_ESSENTIAL_MONTHLY_PLAN_ID; either PAYPAL_SANDBOX_PLAN_ESSENTIAL_ANNUAL PAYPAL_ESSENTIAL_YEARLY_PLAN_ID
  either PAYPAL_SANDBOX_PLAN_PRO_MONTHLY PAYPAL_PRO_MONTHLY_PLAN_ID; either PAYPAL_SANDBOX_PLAN_PRO_ANNUAL PAYPAL_PRO_YEARLY_PLAN_ID
else
  for s in WEBHOOK_ID PRODUCT_ID PLAN_ESSENTIAL_MONTHLY PLAN_ESSENTIAL_ANNUAL PLAN_PRO_MONTHLY PLAN_PRO_ANNUAL; do fatal "PAYPAL_${PE}_$s"; done
  opt PAYPAL_LIVE_ENABLED 'live PayPal operations stay disabled (server still starts)'
fi
echo "=== AI chain"
GOOGLE=false
for p in PRIMARY FALLBACK_1 FALLBACK_2 FALLBACK_3; do
  P=$(val "AI_${p}_PROVIDER" | tr '[:upper:]' '[:lower:]'); [ "$P" = google ] && GOOGLE=true
  if [ -n "$P" ] && [ "$P" != google ] && [ "$P" != openrouter ]; then printf '%-44s %s\n' "AI_${p}_PROVIDER supported" false; FATAL=$((FATAL+1)); echo "    ^ FATAL: server will not start"; fi
  if [ "$p" != PRIMARY ] && { ok "AI_${p}_PROVIDER" || ok "AI_${p}_MODEL"; } && ! { ok "AI_${p}_PROVIDER" && ok "AI_${p}_MODEL"; }; then printf '%-44s %s\n' "AI_${p}_PROVIDER and _MODEL set together" false; FATAL=$((FATAL+1)); echo "    ^ FATAL: server will not start"; fi
done
if [ "$GOOGLE" = true ]; then fatal GEMINI_API_KEY; else opt GEMINI_API_KEY 'not needed: no AI_*_PROVIDER is google'; fi
echo "=== fixed values (true/false only)"
check 'NODE_ENV is production' '[ "$(val NODE_ENV)" = production ]' warn
check 'PAYMENT_PROVIDER is paypal' '[ "$(val PAYMENT_PROVIDER | tr "[:upper:]" "[:lower:]")" = paypal ]' fatal
check 'PAYPAL_ENV is sandbox or live' 'case "$PE" in SANDBOX|LIVE) true;; *) false;; esac' fatal
check 'HOST unset or 127.0.0.1' '! ok HOST || [ "$(val HOST)" = 127.0.0.1 ]' fatal
check 'FRONTEND_URL host is correct' 'case "$(val FRONTEND_URL)" in https://comarkers.roznahub.com|https://comarkers.roznahub.com/*) true;; *) false;; esac' fatal
check 'PUBLIC_API_URL host is correct' 'case "$(val PUBLIC_API_URL)" in https://comarkerback.roznahub.com|https://comarkerback.roznahub.com/*) true;; *) false;; esac' fatal
check 'CORS is exactly the frontend origin' 'c=$(val CORS_ALLOWED_ORIGINS); [ -n "$c" ] || c=$(val CORS_ORIGINS); [ "$c" = https://comarkers.roznahub.com ]' fatal
check 'OCR_SOURCE_MODE is not rejected at start' '! ok OCR_SOURCE_MODE || case "$(val OCR_SOURCE_MODE)" in legacy|hybrid_shadow|gpt_vision_exact) true;; *) false;; esac' fatal
check 'OCR_SOURCE_MODE is gpt_vision_exact' '[ "$(val OCR_SOURCE_MODE)" = gpt_vision_exact ]' warn
check 'OCR model and reader belong together' 'case "$(val OCR_GPT_VISION_MODEL)" in google/gemini-3.8-flash) [ "$(val OCR_GPT_VISION_READER)" = verbatim_json ];; qwen/qwen3.8-27b) case "$(val OCR_GPT_VISION_READER)" in ""|json_contract|plain_text) true;; *) false;; esac;; *) case "$(val OCR_GPT_VISION_READER)" in ""|json_contract) true;; *) false;; esac;; esac' fatal
check 'AI fallback models have a provider prefix' 'r=true; for p in 1 2 3; do [ "$(val AI_FALLBACK_${p}_PROVIDER)" = openrouter ] && ok AI_FALLBACK_${p}_MODEL && ! val AI_FALLBACK_${p}_MODEL | grep -q / && r=false; done; [ "$r" = true ]' warn
check 'OCR_GPT_VISION_MODEL accepted by this mode' '! ok OCR_GPT_VISION_MODEL || [ "$(val OCR_SOURCE_MODE)" != gpt_vision_exact ] || case "$(val OCR_GPT_VISION_MODEL)" in openai/gpt-5.6-sol|openai/gpt-6-astra|deepseek/deepseek-v4.1-flash-1017|qwen/qwen3.8-27b|google/gemini-3.8-flash) true;; *) false;; esac' fatal
check 'OCR_SOURCE_VERIFICATION_MODE allowed' '! ok OCR_SOURCE_VERIFICATION_MODE || [ "$(val OCR_SOURCE_MODE)" = gpt_vision_exact ] || [ "$(val OCR_SOURCE_VERIFICATION_MODE)" = first_pass ]' fatal
check 'GUEST_SUBMISSION_ENABLED is literally true' '[ "$(val GUEST_SUBMISSION_ENABLED)" = true ]' warn
echo "=== optional: the server starts without these, but behaviour changes"
fatal OCR_SOURCE_MODE
fatal OCR_GPT_VISION_MODEL
opt HEALTH_DETAIL_TOKEN 'verify:runtime cannot run; set it (min 16 chars)'
opt GUEST_SUBMISSION_ENABLED 'guest submission answers 403'
opt APP_DEPLOYMENT_REVISION 'health detail cannot name the release'
for n in SMTP_USER SMTP_PASS SMTP_HOST SMTP_PORT SMTP_SECURE MAIL_FROM_EMAIL; do opt "$n" 'email may fail; run node scripts/checkGuestEmailReadiness.js'; done
opt MAIL_FROM_NAME 'default sender name is used'
opt GROQ_API_KEY 'only a startup warning'
opt UNSPLASH_ACCESS_KEY 'only a startup warning'
opt GOOGLE_CLOUD_KEY_FILE 'GOOGLE_APPLICATION_CREDENTIALS is used for Vision instead'
opt ANNOTATION_AUDIT_TTL_DAYS 'audit rows are kept (default)'
echo "=== duplicate keys (the last one wins; remove the others)"
printf '%s\n' "$NAMES" | sort | uniq -d
echo "=== result"
echo "fatal problems found: $FATAL"
echo "NOT checked here: JWT_SECRET length and wording, MONGO_URI not localhost, file at GOOGLE_APPLICATION_CREDENTIALS, values PM2 injects outside .env, ASSESSMENT_* and AI_* timing values, PDF_REPORT_ENGINE, Chromium, indexes."
RC2CHECK
```

It was tested on fake `.env` files in 23 cases against the real `src/server.js`: its fatal count and the boot result agreed in all 23, and no fake secret appeared in its output. It was run with Git Bash on Windows, not on the VPS. It reads `.env` only: dotenv does not override variables already in the process, so anything PM2 injects wins and is not seen here. Check that with `pm2 env <id>` yourself, without pasting values.

### Startup requirements

Every row was booted on both trees with the same fake values, one broken condition at a time, unless marked "read in code". 80 conditions in all, on RC2. The columns below say RC2 and `origin/main`. **RC3 differs in exactly the two OCR rows marked RC3**, because `src/config/ocr.js` changed. Those rows are what a `.env` that worked on `45e49aae` can now fail on.

**Stops the server (exit 1):**

| Requirement | Rule | RC2 | `origin/main` | New in RC2? |
|---|---|---|---|---|
| `NODE_ENV`, `PORT` | Not empty | stops | stops | No |
| `HOST` | Unset, or exactly `127.0.0.1` | stops | stops | No |
| `MONGO_URI` | Not empty, no `localhost` or `127.0.0.1`, reachable | stops | stops | No |
| `JWT_SECRET` | At least 32 characters; no `replace`, `change_me`, `your_`, `your-`, `example`, `placeholder` | stops | stops | No |
| `FRONTEND_URL` | HTTPS, host `comarkers.roznahub.com` | stops | stops | No |
| `PUBLIC_API_URL` | HTTPS, host `comarkerback.roznahub.com` | stops | stops | No |
| `BASE_URL` | Not empty | stops | stops | No |
| `CORS_ALLOWED_ORIGINS` (or `CORS_ORIGINS`) | Exactly `https://comarkers.roznahub.com` | stops | stops | No |
| `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` | Not empty. The key's format is not checked at start, see below | stops | stops | No |
| `GOOGLE_APPLICATION_CREDENTIALS` | Not empty. `GOOGLE_CLOUD_KEY_FILE` does **not** replace it, although `.env.example` lists only that one | stops | stops | No |
| `PAYMENT_PROVIDER` | `paypal`, any case | stops | stops | No |
| `PAYPAL_ENV` | `sandbox` or `live` | stops | stops | No |
| `PAYPAL_<ENV>_CLIENT_ID`, `_CLIENT_SECRET` | Not empty, no legacy name | stops | stops | No |
| `PAYPAL_<ENV>_WEBHOOK_ID`, `_PRODUCT_ID` | Not empty. Sandbox also accepts `PAYPAL_WEBHOOK_ID`, `PAYPAL_PRODUCT_ID` | stops | stops | No |
| `PAYPAL_<ENV>_PLAN_ESSENTIAL_MONTHLY`, `_ESSENTIAL_ANNUAL`, `_PRO_MONTHLY`, `_PRO_ANNUAL` | Not empty. Sandbox also accepts `PAYPAL_ESSENTIAL_MONTHLY_PLAN_ID`, `PAYPAL_ESSENTIAL_YEARLY_PLAN_ID`, `PAYPAL_PRO_MONTHLY_PLAN_ID`, `PAYPAL_PRO_YEARLY_PLAN_ID`. The `..._ANNUAL_PLAN_ID` names in `.env.example` do **not** count | stops | stops | No |
| `PAYPAL_RETURN_URL` and the other five redirect variables, `APP_PUBLIC_URL` | Optional. If set: the frontend origin and the exact route. Tested on `PAYPAL_RETURN_URL` and `APP_PUBLIC_URL`; the rest read in code | stops | stops | No |
| `AI_PRIMARY_PROVIDER`, `AI_PRIMARY_MODEL` | Both set; provider `google` or `openrouter`. The model name itself is not checked | stops | stops | No |
| `AI_FALLBACK_1..3_PROVIDER`, `_MODEL` | Optional, but each pair set together | stops | stops | No |
| `OPENROUTER_API_KEY` | Always, even with a Google primary and the `legacy` OCR mode: the assessment chain needs it | stops | stops | No |
| `GEMINI_API_KEY` | Only if an `AI_*_PROVIDER` is `google` | stops | stops | No |
| `AI_ATTEMPT_TIMEOUT_MS`, `AI_RETRIES_PER_MODEL` (0-2) | Optional, if set must be valid. `AI_TOTAL_BUDGET_MS`, `AI_PRIMARY_RETRIES`, `AI_FALLBACK_RETRIES`, `AI_RETRY_DELAY_MS` follow the same code (read in code) | stops | stops | No |
| `ASSESSMENT_AI_MODEL` | Optional: `google/gemini-3.8-flash` or `openai/gpt-6-astra` | stops | stops | No |
| `GEMINI_RUBRIC_REASONING_EFFORT`, `ASSESSMENT_AI_PRIMARY_RETRIES` | Optional: `low`, `medium`, `high`; at most 1 retry | stops | stops | No |
| `ASSESSMENT_AI_ATTEMPT_TIMEOUT_MS`, `ASSESSMENT_RUBRIC_RESERVED_BUDGET_MS`, `SEMANTIC_AI_MAX_OUTPUT_TOKENS` | Optional: positive integers that fit together; output limit at least 1536. `ASSESSMENT_AI_TOTAL_BUDGET_MS`, `ASSESSMENT_CORRECTION_BUDGET_MS`, `ASSESSMENT_RUBRIC_BUDGET_MS`, `ASSESSMENT_AI_SAFE_OUTPUT_TOKENS` follow the same code (read in code) | stops | stops | No |
| `OCR_SOURCE_MODE` | **RC3: required in production.** On RC2 and `origin/main` optional. On all: these stop it: unknown value, `hybrid`, `astra_verified`, `astra_human_confirm` without its own settings | stops | stops | **Yes, RC3** |
| `OCR_GPT_VISION_MODEL` (with `gpt_vision_exact`) | **RC3: required in production, and `google/gemini-3.8-flash` is allowed, only with `OCR_GPT_VISION_READER=verbatim_json`.** Otherwise one of `openai/gpt-5.6-sol`, `openai/gpt-6-astra`, `deepseek/deepseek-v4.1-flash-1017`, `qwen/qwen3.8-27b` | stops | stops | **Yes, RC3** |
| `OCR_GPT_VISION_ATTEMPT_TIMEOUT_MS` (with Qwen) | Optional: 100000 to 180000 | stops | stops | No |
| `OCR_SOURCE_VERIFICATION_MODE` | Optional, and not read with `gpt_vision_exact`. Otherwise only `first_pass` | stops | stops | No |
| `PDF_REPORT_ENGINE`, `PUPPETEER_EXECUTABLE_PATH` | Optional: `puppeteer`; an existing file. A usable Chromium must be found either way | stops | stops | No |
| Flashcard indexes | Step 4 | stops | stops | No |
| MongoDB user may create indexes (with `gpt_vision_exact`) | Startup creates two `sourcefidelity*` indexes. Read in code, a restricted user was not tried | not run | not run | No |
| Upload folders can be created | `src/app.js` creates them on load. Read in code, not tried | not run | not run | No |

**Starts, then fails when used:**

| Condition | What happens | Evidence |
|---|---|---|
| `FIREBASE_PRIVATE_KEY` malformed | Health is fine; `POST /api/auth/login` answers 503 `AUTH_PROVIDER_UNAVAILABLE`, the process stays up | Run on both trees |
| File at `GOOGLE_APPLICATION_CREDENTIALS` absent | Starts. The legacy reader's Vision client needs it later | Boot run on both trees; the later failure read in code |
| `GUEST_SUBMISSION_ENABLED` absent or not literally `true` | Guest upload answers 403 `GUEST_SUBMISSION_UNAVAILABLE` | Run on RC2; code unchanged from `origin/main` |
| Guest indexes missing | Guest upload answers 503 `GUEST_INDEX_SETUP_REQUIRED` | Run on RC2; check unchanged from `origin/main` |
| `credittransactions` unique `idempotencyKey` index missing | Credit changes answer 503 `CREDIT_INDEX_REQUIRED` | Read in code |
| `paymentcheckoutattempts` unique partial `activeOperationKey` index missing | Checkout answers 503 `PAYMENT_INDEX_REQUIRED` | Read in code |
| No active Free plan in `plans` | `Free plan is not configured` on the paths that need it | Read in code |
| `SMTP_*`, `MAIL_FROM_*` missing or inconsistent | Starts; email fails. `node scripts/checkGuestEmailReadiness.js` reports without values and without sending | Read in code, script not run |

**RC3 stops at startup when `OCR_SOURCE_MODE` or `OCR_GPT_VISION_MODEL` is missing.** RC2 had no such guard; a missing value there silently selected a default:

| Variable | If missing |
|---|---|
| `OCR_SOURCE_MODE` | `legacy` reader |
| `OCR_GPT_VISION_MODEL` (with `gpt_vision_exact`) | `openai/gpt-5.6-sol`, not the Qwen model |

**The production log does not show which reader or model is active.** The `ocr_source_configuration` line is logged at `info`, and `info` is off when `NODE_ENV=production` (`src/utils/logger.js`); it did not appear in any production-mode boot here. So verify `OCR_SOURCE_MODE` and `OCR_GPT_VISION_MODEL` from `.env`, not from `pm2 logs`. So check both are set. **On a rollback to RC2, `OCR_GPT_VISION_MODEL=google/gemini-3.8-flash` stops the server** (`OCR_GPT_SOURCE_CONFIGURATION_INVALID`): the Gemini reader is not in RC2, so restore the backed-up `.env` too. RC2 does not read `OCR_GPT_VISION_READER` or `OCR_GPT_VISION_SECOND_READER`.

```
grep -cE '^PAYMENT_PROVIDER=["'"'"']?paypal' .env          # must be 1
grep -cE '^OCR_GPT_VISION_MODEL=' .env                     # must be 1: more than one means a duplicate, and the last wins
```

New variables against `origin/main` that the running server reads. All optional. A bad value in the first three `OCR_GPT_VISION_*` rows stops the server; the rest fall back or do nothing:

| Variable | Default | Note |
|---|---|---|
| `OCR_GPT_VISION_READER` | `json_contract` | Set `verbatim_json` for Gemini, see the top of this file. A wrong pair stops the server. |
| `OCR_GPT_VISION_REASONING` | `low` | `low`, `medium` or `high`. Leave it. |
| `OCR_GPT_VISION_TEMPERATURE` | `0` | `0` or `omit`. Leave it. |
| `OCR_GPT_VISION_SECOND_READER` | off | Leave it off. |
| `HEALTH_DETAIL_TOKEN` | unset | Min 16 characters (`openssl rand -hex 32`). Unset: `/api/health` never shows detail and `npm run verify:runtime` reports `HEALTH_DETAIL_TOKEN_MISSING`. Set it, step 6 needs it. |
| `ANNOTATION_RATE_LIMIT_MAX` / `ANNOTATION_RATE_LIMIT_WINDOW_MS` | 120 / 900000 | optional |
| `ANNOTATION_AUDIT_TTL_DAYS` | unset (kept) | If you set it, run the index migration after setting it. |
| `RECOVERY_LINK_TTL_HOURS`, `RECOVERY_LINK_MAX_USES`, `RECOVERY_SESSION_MINUTES`, `RECOVERY_EMAILS_PER_HOUR`, `RECOVERY_EMAIL_COOLDOWN_SECONDS`, `RECOVERY_REQUESTS_PER_HOUR`, `RECOVERY_TEACHER_SENDS_PER_HOUR` | 24 / 10 / 30 / 3 / 120 / 10 / 20 | optional |

Recovery and guest pages also need `GUEST_SUBMISSION_ENABLED=true` (literally), working `SMTP_*` and `MAIL_FROM_*`. `OCR_EVAL_DIR` and `OCR_EVAL_OUT` are new names too, read only by the offline `scripts/ocr-eval` tools; do not set them on the VPS.

## 2. Backup

Take an Atlas snapshot and note its name: this is the real backup. Then keep what a rollback needs, outside the web root, because these hold student data and secrets:

```
TS=$(date +%Y%m%d-%H%M%S); BK=~/backups/rc2-$TS; mkdir -p "$BK"; chmod 700 "$BK"
cd BACKEND_DIR && git rev-parse HEAD > "$BK/backend.commit" && cp .env "$BK/backend.env" && chmod 600 "$BK/backend.env"
tar -czf "$BK/frontend-dist.tgz" -C FRONTEND_DIR dist
du -sh "$BK"/*
```

## 3. Get the code

The RC3 branches may exist only on the developer's machine. The VPS cannot fetch them until one of these is done on that machine:

```
git push origin release-candidate-3          # backend repo; or:
git bundle create rc3.bundle release-candidate-3   # copy rc3.bundle to the VPS, then: git fetch rc3.bundle release-candidate-3
```

Never deploy `origin/ocr-verbatim-hardening`. On the VPS: `cd BACKEND_DIR && git fetch && git checkout <RC3 commit>`. `release-candidate-3` is a fast-forward of `origin/main` (`45e49aae`), so nothing on the server is lost. The VPS working tree has modified `node_modules` files; RC3 changes no tracked file under `node_modules`, so they are left alone. Never use `git reset --hard` or `git clean` there.

**Do NOT run `npm install` or `npm ci` on the VPS for the backend.** RC3 adds no dependency: `package-lock.json`, `pnpm-lock.yaml` and the tracked `node_modules` are unchanged from `origin/main`, and `package.json` only gains four scripts (`npm run <script>` is fine). `npm ci` would delete and rebuild `node_modules`, including the Puppeteer browser and native modules.

**Build the frontend locally and upload it** (`RoznaComarker/DEPLOYMENT.md`): the repo has no lockfile, so an `npm install` on the VPS can bring different versions.

## 4. Migrations (with the new code on disk, before the restart)

### Index prerequisites: look first

Compare with the real database first. This is read-only; it was not run in `mongosh` (no `mongosh` here), so treat the snippet as untested.

```
['flashcardsubmissions','flashcardsets','submissions','credittransactions','paymentcheckoutattempts','recoverytokens','recoverysessions','recoveryemailwindows','recoverylinkaudits','annotationaudits'].forEach(function (c) { print('== ' + c); try { db.getCollection(c).getIndexes().forEach(function (i) { print(i.name, JSON.stringify(i.key), i.unique ? 'unique' : '-', JSON.stringify(i.partialFilterExpression || '-'), i.expireAfterSeconds === undefined ? '-' : 'ttl ' + i.expireAfterSeconds); }); } catch (e) { print('(no collection)'); } });
```

Names, keys and options below are the real output of the scripts on a test database, except where marked. The checks that block compare key, unique and partial filter; they do **not** compare the name, so a different name with the same shape is fine.

**Blocks startup if missing or different:**

| Collection | Name | Key | Options | Created by |
|---|---|---|---|---|
| `flashcardsubmissions` | `flashcardSetId_1_userId_1` | `{flashcardSetId:1,userId:1}` | unique, partial `{assignmentId:null}` | `npm run migrate:flashcard-indexes` |
| `flashcardsubmissions` | `assignmentId_1_userId_1` | `{assignmentId:1,userId:1}` | unique, partial `{assignmentId:{$type:"objectId"}}` | same |
| `flashcardsets` | `shareToken_1` | `{shareToken:1}` | unique, partial `{shareToken:{$type:"string"}}` | same |

A same-key index with other options also stops the server. Run `npm run migrate:flashcard-indexes` **only if the comparison shows a difference**: it is not read-only. It first refuses if there are duplicates (`Duplicate data prevents index ...`), then drops same-key indexes with other options, creates the missing ones, and removes `shareToken: null` from `flashcardsets` documents. It needs the Atlas snapshot from step 2.

**Blocks guest upload if missing or different (503 `GUEST_INDEX_SETUP_REQUIRED`):**

| Collection | Name | Key | Options |
|---|---|---|---|
| `submissions` | `student_1_assignment_1` | `{student:1,assignment:1}` | unique, partial `{student:{$type:"objectId"}}` |
| `submissions` | `assignment_1_guestRequestKey_1` | `{assignment:1,guestRequestKey:1}` | unique, partial `{guestRequestKey:{$type:"string"}}` |

Both were tested separately: a non-partial student index blocks, and a missing guest index blocks. The server starts in all these cases; only guest upload fails. Created by `node scripts/ensureGuestSubmissionIndexes.js` (no npm script):

```
node scripts/ensureGuestSubmissionIndexes.js                              # dry run
node scripts/ensureGuestSubmissionIndexes.js --apply --writers-stopped    # maintenance window, app stopped
```

- The dry run only looks at the **student** index. `requiresMaintenanceWindow:false` does not prove the guest index exists: use the comparison above.
- If the student index is the old non-partial one, `--apply` **drops and rebuilds a unique index on student submissions**. Nothing protects uniqueness in between, so stop the app first.
- It uses the app's connection, so it needs the full `.env` and the flashcard indexes. Every failure prints the same line, `Guest index setup failed. Keep writers stopped...`, even on a dry run that wrote nothing; in the test that line appeared when the flashcard indexes were missing, when `--writers-stopped` was left out, and when `submissions` did not exist.

**Blocks only the feature at first use (read in code, not run):** `credittransactions` unique `{idempotencyKey:1}` (`idempotencyKey_1`); `paymentcheckoutattempts` unique `{activeOperationKey:1}`, partial `{activeOperationKey:{$type:"string"}}`.

**Does not block anything.** With all of these absent, a teacher hide, a recovery request, the link exchange and portal results all answered normally:

| Collection | Name | Key | Options | Effect if missing |
|---|---|---|---|---|
| `submissions` | `guest_recovery_lookup_v1` | `{assignment:1,"guest.normalizedEmail":1,submittedAt:-1}` | partial `{submissionMode:"guest"}` | Slower lookup (read in code) |
| `submissions` | `guest_result_email_queue_v1` | `{submissionMode:1,assessmentStatus:1,"guest.resultEmailSentAt":1,"guest.resultEmailNextAttemptAt":1}` | | Slower queue (read in code) |
| `submissions` | `assessment_recovery_scan_v1` | `{ocrStatus:1,analysisNextRetryAt:1,analysisLeaseExpiresAt:1,updatedAt:1}` | `npm run migrate:assessment-recovery-index` | Slower scan (read in code) |
| `recoverytokens` | `recovery_token_hash_v1` | `{tokenHash:1}` | unique | No uniqueness guarantee |
| `recoverytokens` | `recovery_token_email_v1` | `{emailNormalized:1,createdAt:-1}` | | Slower lookup |
| `recoverytokens` | `recovery_token_purge_v1` | `{purgeAt:1}` | TTL 0 | Old tokens stay |
| `recoverysessions` | `recovery_session_hash_v1` | `{sessionHash:1}` | unique | No uniqueness guarantee |
| `recoverysessions` | `recovery_session_token_v1` | `{tokenId:1}` | | Slower lookup |
| `recoverysessions` | `recovery_session_purge_v1` | `{expiresAt:1}` | TTL 3600 | Old sessions stay |
| `recoveryemailwindows` | `recovery_email_window_purge_v1` | `{expiresAt:1}` | TTL 0 | Old windows stay |
| `recoverylinkaudits` | `recovery_link_audit_submission_v1` | `{submissionId:1,createdAt:-1}` | | Slower lookup |
| `recoverylinkaudits` | `recovery_link_audit_teacher_v1` | `{issuedBy:1,createdAt:-1}` | | Slower lookup |
| `recoverylinkaudits` | `recovery_link_audit_ttl_v1` | `{createdAt:1}` | TTL 31536000 | Old rows stay |
| `annotationaudits` | `annotation_audit_request_v1` | `{submissionId:1,requestId:1}` | unique | No uniqueness guarantee on the audit |
| `annotationaudits` | `annotation_audit_submission_v1` | `{submissionId:1,newRevision:-1}` | | Slower history |

With `gpt_vision_exact` the server creates two more at start: `sourcefidelityevidences` `expiresAt_1` (TTL 0) and `sourcefidelitysnapshots` `submissionId_1`. `annotation_audit_ttl_v2` exists only if `ANNOTATION_AUDIT_TTL_DAYS` is set.

### Run for RC3, in this order

The app connects with `autoIndex: false, autoCreate: false`, so it never creates these itself. Both index scripts touch only new collections (`recovery*`, `annotationaudits`), add what is missing and are safe to repeat. **They have no dry run: running them without a flag creates the indexes.** The one exception to "only adds": `migrate:annotation-indexes` drops `annotation_audit_ttl_v1` if a pre-release database has it. It does not exist on `45e49aae`.

```
cd BACKEND_DIR
npm run migrate:recovery-portal-indexes
npm run migrate:annotation-indexes       # run twice; the second run must change nothing
npm run report:score-review              # read-only counts
```

Without them the app still runs, but expired recovery links and sessions are never removed, lookups scan, and the uniqueness of `annotation_audit_request_v1` is missing.

| Script | Without a flag | Repeat safe |
|---|---|---|
| `migrate:recovery-portal-indexes` | **applies** | yes |
| `migrate:annotation-indexes` | **applies** | yes |
| `report:score-review` | read-only, it has no write mode | yes |
| `migrate:teacher-annotations` | dry run, counts only | yes: version 2 overlays are skipped |

**Optional data migration (version 1 teacher overlays to version 2).** Only relevant if the database has them (on `45e49aae` it cannot). Count them in mongosh: `db.submissions.countDocuments({teacherAnnotations:{$exists:true},'teacherAnnotations.version':{$ne:2}})`. The code reads both formats.

```
npm run migrate:teacher-annotations                                                     # no flag = dry run, counts only. --dry-run is rejected.
npm run migrate:teacher-annotations -- --apply --backup-confirmed --backup=/home/APP_USER/backups/ta-backup.jsonl
npm run migrate:teacher-annotations -- --reverse --backup-confirmed --backup=/home/APP_USER/backups/ta-backup.jsonl
```

## 5. Deploy order: backend first, then frontend

Reason: the new frontend calls routes the old backend does not have (annotations, recovery portal), so those screens would fail; the old frontend on the new backend was seen in the RC1 rehearsal only to show "Student" instead of the teacher's name until refreshed. **(unverified for RC3: the compatibility check was done on RC1.)**

```
# set APP_DEPLOYMENT_REVISION in .env to the RC3 commit, then:
pm2 restart RoznaComarker_Backend --update-env
pm2 logs RoznaComarker_Backend --lines 100 --nostream
```

If it exits at start, read the config error. Most name the problem, but **the AI ones do not**: `AI configuration validation failed` and `Global AI model chain configuration is invalid` do not say which variable. Go back to the step 1 check, the AI chain section. `pm2 logs` shows nothing about the OCR mode in any case (step 1). Then upload the frontend build (`dist/rozna-comarker-fe/browser`) to where the site is served from. **(unverified: whether the VPS serves it with Nginx directly or through `serve`; see `RoznaComarker/DEPLOYMENT.md`.)**

## 6. Verification

```
curl -s https://comarkerback.roznahub.com/api/health                     # {"success":true,"status":"OK"} only
TOKEN=$(grep -E '^HEALTH_DETAIL_TOKEN=' .env | cut -d= -f2-)
curl -s -H "X-Deploy-Token: $TOKEN" https://comarkerback.roznahub.com/api/health | head -c 400; echo
HEALTH_DETAIL_TOKEN="$TOKEN" RUNTIME_HEALTH_URL=https://comarkerback.roznahub.com/api/health npm run verify:runtime; unset TOKEN
curl -I https://comarkers.roznahub.com/                  # cache-control: no-cache
curl -I https://comarkers.roznahub.com/version.json      # no-store
curl -I https://comarkers.roznahub.com/<main-xxxx>.js    # public, max-age=31536000, immutable
```

`version.json` releaseId must equal the `app-release` meta in index.html.

Smoke test on a test account, never a real student's work: follow MANUAL_QA_CHECKLIST.md. A real submission through the AI is first exercised here. Watch `pm2 logs` for 15 minutes, then `pm2 save`.

## 7. Rollback

**Triggers:** the backend is not up within 2 minutes or restarts in a loop; `verify:runtime` fails; a correction the teacher hid is visible to a student, or anyone sees another person's data; highlights are broken with no fix within 15 minutes; uploads or assessment stop working that worked before; 5xx responses clearly increase (`/api/subscription/me` aside, see KNOWN_RISKS).

**Frontend** (restore the dist backup; do this first if the backend rolls back too):

```
tar -xzf "$BK/frontend-dist.tgz" -C FRONTEND_DIR
curl -s https://comarkers.roznahub.com/version.json    # must show the old releaseId
```

**Backend** (reset to the previous commit and restart):

```
cd BACKEND_DIR
cp "$BK/backend.env" .env                     # the RC3 .env selects Gemini, which older code refuses
git reset --keep "$(cat "$BK/backend.commit")"  # --keep, not --hard: the modified node_modules files must stay
pm2 restart RoznaComarker_Backend --update-env
pm2 logs RoznaComarker_Backend --lines 100 --nostream
curl -s https://comarkerback.roznahub.com/api/health
```

`--keep` stops with an error rather than overwrite a locally modified file that differs between the two commits. RC3 has none under `node_modules`. If the branch on the VPS is detached at the RC3 commit, `git checkout "$(cat "$BK/backend.commit")"` does the same. Leave the new indexes: the old code ignores them. These commands were not run on a VPS.

**Reader only** (the code stays on RC3, for transcription problems): set `OCR_GPT_VISION_MODEL=qwen/qwen3.8-27b` and `OCR_GPT_VISION_READER=json_contract`, then `pm2 restart RoznaComarker_Backend --update-env`.

Known cost of a backend rollback to `45e49aae`: the old code has no teacher-review filter, so corrections teachers hid become visible to students again, and the recovery portal and teacher recovery links stop working. The saved decisions stay in the database and apply again when you roll forward. If you ran the data migration, run `--reverse` first only if you need the old format back.

Last resort: restore the Atlas snapshot (loses everything written since).
