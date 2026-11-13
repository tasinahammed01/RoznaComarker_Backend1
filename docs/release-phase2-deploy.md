# Release phase 2: deploy checklist (backend + frontend together)

Branch `release/phase2` in both repos. Contents: brand (logo, favicon, login, emails, PDF cover), teacher upload of student work, the
Improved Writing Model per student submission, the assessment category order, the correction show/hide toggle, form fixes, AI knowledge and
reference files (**deployed OFF**), and `tmp/` no longer tracked (backend).

Nothing here has been run on the VPS. `docs/release-rc1/DEPLOY_RUNBOOK.md` stays the reference for the general procedure (step 0 "which
commit is production on?", PM2, verification, rollback). Replace `BACKEND_DIR`, `FRONTEND_DIR`, `APP_USER`.

**Deploy the backend and the frontend together, in one window.** The old frontend calls `/api/assignments/:id/writing-model`, which this
backend no longer has (the writing model is per submission now), and the new frontend calls routes the old backend does not have.

## 1. Before you start

- [ ] Production commit known (runbook step 0); `release/phase2` pushed (see the push commands) and its commit noted.
- [ ] Atlas snapshot taken, name noted.
- [ ] Backups (outside the web root; they hold student data and secrets):
  ```
  TS=$(date +%Y%m%d-%H%M%S); BK=~/backups/phase2-$TS; mkdir -p "$BK"; chmod 700 "$BK"
  cd BACKEND_DIR && git rev-parse HEAD > "$BK/backend.commit" && cp .env "$BK/backend.env" && chmod 600 "$BK/backend.env"
  tar -czf "$BK/frontend-dist.tgz" -C FRONTEND_DIR dist
  tar -czf "$BK/uploads.tgz" -C BACKEND_DIR uploads          # teacher-uploaded student work, submissions, avatars...
  tar -czf "$BK/node_modules.tgz" -C BACKEND_DIR node_modules # dependencies change in this release (step 3)
  ```
- [ ] Proxy (Nginx/CloudPanel) for the backend domain: `proxy_read_timeout 120s` or more. "Retry marking" can run the handwriting check
  for pages that were never checked before answering, and the rubric draft from a file waits for one AI call. Also
  `client_max_body_size` at least `11m` (reference files are up to 10 MB; teacher uploads keep their existing limit).

## 2. Code

```
cd BACKEND_DIR
git status --short | grep -v ' node_modules/'      # must print nothing
git fetch origin && git merge --ff-only <release/phase2 commit, or origin/main after the push>
git log -1 --format='%h %s'
```

The backend no longer tracks `tmp/`: the fast-forward **deletes the old tracked files under `tmp/`** on the server (browser test profiles,
a rendered PDF, notes). Nothing in `src/` or `tests/` reads them. If you want to keep a copy, take it before the merge.

## 3. Dependencies (required: the server does not start without them)

This release adds `word-extractor` and declares `yauzl` and `cfb` directly (`package-lock.json` changed). The reference-file routes are
mounted at startup even while the feature is off, and they load `yauzl` and `cfb` at once. The old lockfile had only a dev-only `yauzl` 3.x at
the top level, so a server installed without dev dependencies would fail to start with `Cannot find module 'yauzl'`.

The runbook warns against `npm ci` on the VPS (it deletes and rebuilds `node_modules`, including the Puppeteer browser and native modules).
Add what is missing from the committed lockfile instead, then check:

```
cd BACKEND_DIR
npm install --omit=dev --no-audit --no-fund          # follows package-lock.json; adds word-extractor and the top-level yauzl
node -e "require('yauzl'); require('cfb'); require('word-extractor'); require('./src/app'); console.log('dependencies ok')"
```

The last line must print `dependencies ok`. Not tried on the VPS. If `npm install` wants to change far more than these three packages, stop
and restore `node_modules.tgz`.

## 4. Environment (`.env`)

Remove duplicate keys first (the last one wins): `grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' .env | sort | uniq -d`.

| Variable | Value | Why |
|---|---|---|
| `GUEST_SUBMISSION_ENABLED` | `true` (literally) | guest submission and recovery pages |
| `FRONTEND_URL` | `https://comarkers.roznahub.com` | links in emails; the email logo is built from it |
| `MAIL_FROM_NAME` | `Rubrilo` | sender name |
| `EMAIL_LOGO_URL` | unset, or an https URL of the **new** logo | must not point to the old `rubrilo-symbol*` image: `grep -n '^EMAIL_LOGO_URL' .env` |
| `REFERENCE_FILES_ENABLED` | **absent** (or `false`) | the reference-file feature stays off in this release; see section 8 |
| `IMPROVED_WRITING_MODEL_ENABLED` | as decided | unchanged meaning; the model is now per student submission |

## 5. Migrations (new code on disk, before the restart)

All three are additive (they create named indexes only, never drop) and safe to repeat. **They have no dry run: running them creates the
indexes.** Run each twice; the second run must change nothing.

```
npm run migrate:teacher-upload-indexes
npm run migrate:submission-writing-model-indexes   # also prints how many old assignment-wide models exist (kept, no longer shown)
npm run migrate:reference-file-indexes             # harmless while the feature is off; makes turning it on later a switch only
```

## 6. Restart, then the frontend

```
pm2 restart RoznaComarker_Backend --update-env
pm2 logs RoznaComarker_Backend --lines 100 --nostream
curl -s https://comarkerback.roznahub.com/api/health
```

Frontend: on the developer machine, at `release/phase2`, build with `npm run build:prod` (never plain `ng build`) and upload
`dist/rozna-comarker-fe/browser` to the folder the site is served from. Then:

```
curl -sI https://comarkers.roznahub.com/ | grep -i cache-control                 # no-cache
curl -s  https://comarkers.roznahub.com/version.json                              # the new releaseId
curl -sI "https://comarkers.roznahub.com/logo_and_icon/app-icon/rubrilo-app-icon-light-32.png?v=2"   # 200 image/png
```

## 7. Smoke test (test accounts and made-up work only; never a real student's work)

- [ ] Login page: new logo top left, smaller card; the browser tab shows the new icon (hard refresh once).
- [ ] Landing page, guest submission, guest results, recovery: the new logo; footer uses the light logo on teal.
- [ ] Teacher: upload a student's handwritten work for a test student; the status goes Uploaded → Reading → Marking → Marked; Retry marking
      on a failed or stalled one says "Marking restarted" (or "already running").
- [ ] The feedback email arrives with the new logo (check the image loads in Gmail/Outlook); the PDF cover shows the new logo.
- [ ] Improved Writing Model on one submission: save, submit; the student sees it on that submission only.
- [ ] Hide a correction with the eye toggle: it disappears for the student (page and PDF); show it again: it is back.
- [ ] Reference files are invisible everywhere (feature off): no "Reference files for AI marking" in the class or assignment forms;
      `GET /api/reference-files/classes/<id>` answers 404; `/api/reference-files/config` answers `{"enabled":false}`.
- [ ] `pm2 logs` for 15 minutes; then `pm2 save`.

## 8. Rollback

Runbook section 7: restore `backend.env`, `git reset --keep "$(cat "$BK/backend.commit")"`, restore `node_modules.tgz` if the install changed
it, restart, restore the frontend dist. New indexes can stay (the old code ignores them). Writing models saved per submission stay in the
database but are not shown by the old code.

## 9. Turning the reference-file feature ON (later, separately)

See `docs/reference-files-deployment.md`: prerequisites, the switch, and a test with real teacher files.
