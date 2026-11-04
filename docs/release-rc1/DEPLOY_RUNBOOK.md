# Release Candidate 2 - deploy runbook (Linux VPS, PM2, Nginx/CloudPanel)

These files keep the `docs/release-rc1/` path they were brought from; their content is for RC2. Backend branch `release-candidate-2`, frontend branch `highlight-sync`. RC2 is RC1 without the OCR reader work. Nothing here has been run on production. Replace `BACKEND_DIR`, `FRONTEND_DIR` and `APP_USER` with the real values. Steps marked **(unverified)** depend on the VPS, which could not be reached when this was written.

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

## 1. Environment

Read the production `.env` yourself and print names only. The startup rules that already apply and still stop the server: `PAYMENT_PROVIDER` must be `paypal` (and the PayPal runtime values must validate), `FRONTEND_URL`, `PUBLIC_API_URL`, `CORS_ALLOWED_ORIGINS`, `JWT_SECRET`, `HOST=127.0.0.1`.

**RC2 has no startup guard for OCR variables.** A missing value does not stop the server, it silently selects a default:

| Variable | If missing |
|---|---|
| `OCR_SOURCE_MODE` | `legacy` reader |
| `OCR_GPT_VISION_MODEL` (with `gpt_vision_exact`) | `openai/gpt-5.6-sol`, not the Qwen model |

So check both are set. **`OCR_GPT_VISION_MODEL=google/gemini-3.8-flash` stops RC2 at startup** (`OCR_GPT_SOURCE_CONFIGURATION_INVALID`): the Gemini reader is not in RC2. `OCR_GPT_VISION_READER` and `OCR_GPT_VISION_SECOND_READER` are not read by RC2; remove them or leave them.

```
grep -cE '^PAYMENT_PROVIDER=["'"'"']?paypal' .env          # must be 1
grep -cE '^OCR_GPT_VISION_MODEL=.*gemini' .env             # must be 0
```

New variables, none of which stops the server:

| Variable | Default | Note |
|---|---|---|
| `HEALTH_DETAIL_TOKEN` | unset | Min 16 characters (`openssl rand -hex 32`). Unset: `/api/health` never shows detail and `npm run verify:runtime` reports `HEALTH_DETAIL_TOKEN_MISSING`. Set it, step 6 needs it. |
| `ANNOTATION_RATE_LIMIT_MAX` / `ANNOTATION_RATE_LIMIT_WINDOW_MS` | 120 / 900000 | optional |
| `ANNOTATION_AUDIT_TTL_DAYS` | unset (kept) | If you set it, run the index migration after setting it. |
| `RECOVERY_LINK_TTL_HOURS`, `RECOVERY_LINK_MAX_USES`, `RECOVERY_SESSION_MINUTES`, `RECOVERY_EMAILS_PER_HOUR`, `RECOVERY_EMAIL_COOLDOWN_SECONDS`, `RECOVERY_REQUESTS_PER_HOUR`, `RECOVERY_TEACHER_SENDS_PER_HOUR` | 24 / 10 / 30 / 3 / 120 / 10 / 20 | optional |

Recovery and guest pages also need `GUEST_SUBMISSION_ENABLED=true` (literally), working `SMTP_*` and `MAIL_FROM_*`.

## 2. Backup

Take an Atlas snapshot and note its name: this is the real backup. Then keep what a rollback needs, outside the web root, because these hold student data and secrets:

```
TS=$(date +%Y%m%d-%H%M%S); BK=~/backups/rc2-$TS; mkdir -p "$BK"; chmod 700 "$BK"
cd BACKEND_DIR && git rev-parse HEAD > "$BK/backend.commit" && cp .env "$BK/backend.env" && chmod 600 "$BK/backend.env"
tar -czf "$BK/frontend-dist.tgz" -C FRONTEND_DIR dist
du -sh "$BK"/*
```

## 3. Get the code

The RC2 branches may exist only on the developer's machine. The VPS cannot fetch them until one of these is done on that machine:

```
git push origin release-candidate-2          # backend repo; or:
git bundle create rc2.bundle release-candidate-2   # copy rc2.bundle to the VPS, then: git fetch rc2.bundle release-candidate-2
```

Never deploy `origin/ocr-verbatim-hardening`. On the VPS: `cd BACKEND_DIR && git fetch && git checkout <RC2 commit>`.

**Do NOT run `npm` on the VPS for the backend.** RC2 adds no dependency: `package-lock.json` and the tracked `node_modules` are unchanged from `origin/main`, and `package.json` only gains four scripts. `npm ci` would delete and rebuild `node_modules`, including the Puppeteer browser and native modules.

**Build the frontend locally and upload it** (`RoznaComarker/DEPLOYMENT.md`): the repo has no lockfile, so an `npm install` on the VPS can bring different versions.

## 4. Migrations (with the new code on disk, before the restart)

The app connects with `autoIndex: false, autoCreate: false`, so it never creates these itself. Both only add indexes to new, empty collections and are safe to repeat.

```
cd BACKEND_DIR
npm run migrate:recovery-portal-indexes
npm run migrate:annotation-indexes       # run twice; the second run must change nothing
npm run report:score-review              # read-only counts
```

Without them the app still runs, but expired recovery links and sessions are never removed, lookups scan, and the uniqueness of `annotation_audit_request_v1` is missing.

**Optional data migration (version 1 teacher overlays to version 2).** Only relevant if the database has them (on `45e49aae` it cannot). Count them in mongosh: `db.submissions.countDocuments({teacherAnnotations:{$exists:true},'teacherAnnotations.version':{$ne:2}})`. The code reads both formats.

```
npm run migrate:teacher-annotations                                                     # no flag = dry run, counts only. --dry-run is rejected.
npm run migrate:teacher-annotations -- --apply --backup-confirmed --backup=/home/APP_USER/backups/ta-backup.jsonl
npm run migrate:teacher-annotations -- --reverse --backup-confirmed --backup=/home/APP_USER/backups/ta-backup.jsonl
```

## 5. Deploy order: backend first, then frontend

Reason: the new frontend calls routes the old backend does not have (annotations, recovery portal), so those screens would fail; the old frontend on the new backend was seen in the RC1 rehearsal only to show "Student" instead of the teacher's name until refreshed. **(unverified for RC2: the compatibility check was done on RC1.)**

```
# set APP_DEPLOYMENT_REVISION in .env to the RC2 commit, then:
pm2 restart RoznaComarker_Backend --update-env
pm2 logs RoznaComarker_Backend --lines 100 --nostream
```

If it exits at start, read the config error: it names the problem. Then upload the frontend build (`dist/rozna-comarker-fe/browser`) to where the site is served from. **(unverified: whether the VPS serves it with Nginx directly or through `serve`; see `RoznaComarker/DEPLOYMENT.md`.)**

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

Frontend: restore `frontend-dist.tgz` from the backup.

Backend: `git checkout "$(cat $BK/backend.commit)"`, restore `backend.env` if changed, `pm2 restart RoznaComarker_Backend --update-env`. Leave the new indexes: the old code ignores them.

Known cost of a backend rollback to `45e49aae`: the old code has no teacher-review filter, so corrections teachers hid become visible to students again, and the recovery portal and teacher recovery links stop working. The saved decisions stay in the database and apply again when you roll forward. If you ran the data migration, run `--reverse` first only if you need the old format back.

Last resort: restore the Atlas snapshot (loses everything written since).
