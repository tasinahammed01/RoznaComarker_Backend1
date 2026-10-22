# Isolated localhost shadow mode

From the workspace root:

```powershell
node backend/scripts/local-shadow/start.cjs
```

This starts a cached mongodb-memory-server mongod replica set with persistent WiredTiger files, the real Express app, and Angular's explicit local-shadow configuration. It does not modify or load the existing backend .env. Stop any other service on ports 4200, 5001 and 27028 first; the launcher refuses occupied ports rather than reusing an unknown service.

- Frontend: http://localhost:4200 (loopback-bound)
- Backend: http://127.0.0.1:5001
- Mongo: mongodb://127.0.0.1:27028/rozna_shadow_local?replicaSet=localShadow
- Database files: backend/.local-shadow/db
- Uploads: backend/.local-shadow/uploads
- Private session handoff: backend/.local-shadow/private/session.json
- Private shadow review collection: CorrectionShadowReview in the local database, retaining the existing private/TTL behavior
- Future authorized image: staging-test-data/handwritten-page-01.jpg (not supplied or uploaded during setup)

The launcher strips inherited application/provider configuration, prevents dotenv fallback to backend/.env, generates an ephemeral local-only signing key and non-provider Firebase initialization material, and pins database/storage/mode. No real service credentials are loaded. Runtime placeholders exist solely to satisfy the app's declared integration configuration; they cannot authenticate to PayPal, Firebase or OCR. Login and payments are unavailable in this offline guest-only mode.

It seeds synthetic local-only teacher/class/guest-enabled assignment documents and a local free plan through existing models. It checks the teacher's actual credit policy without consuming a credit; it does not mock or bypass authorization/credits. Guest name/email entry is the normal application's guest flow, not a synthetic login backdoor. Read assignmentUrl from the private session file and open it in the browser. The local guest share URL is private handoff data; do not commit it. No student account, production account or real Firebase account is required.

NODE_ENV=staging activates the existing hook only in this process. CORRECTION_PIPELINE_MODE=shadow_v15 and OCR_SOURCE_MODE=legacy are pinned. The adapter registration is explicitly empty: GENERATOR_NOT_CONFIGURED, no verifier. Merely starting this session does not create a shadow record; that state can be persisted only after a qualifying completed OCR page. No image or fake OCR completion is created to demonstrate it.

## Provider and background safety

Outbound HTTP/HTTPS/fetch and raw socket destinations are restricted to loopback in the backend process. Existing real single-upload dispatch is untouched, but OCR cannot run successfully in this preparation mode: no credentials exist and outbound provider transport is blocked. No real provider call is permitted during setup. Do not submit a page merely to test the missing generator state.

The launcher uses the existing app directly instead of server.js's production startup, so it starts neither entitlement nor assessment-recovery background workers. ASSESSMENT_RECOVERY_ENABLED=false is set as well. Normal request-triggered submission analysis remains the existing implementation; no production middleware is disabled and no private result is exposed publicly. This is a local harness, not a deployable replacement server. Do not deploy it remotely.

The frontend has a separate compiled environment with every API alias targeting the isolated backend and no shared Firebase project. Angular's production configuration/default and environment.prod.ts are unchanged. User-facing login is intentionally unavailable. Browser verification blocks external requests before navigating, and only inspects the normal guest page and API response.

## Verification commands

```powershell
# Local DB + backend + guest metadata + real credit checks, then stop; no frontend/upload:
node backend/scripts/local-shadow/start.cjs --smoke
# Also start frontend, inspect guest upload form in headless Chrome, then stop:
node backend/scripts/local-shadow/start.cjs --verify
```

The mongod binary must already be cached by the installed mongodb-memory-server infrastructure. Runtime binary downloads are disabled. If missing, install/provide the Mongo binary separately; this launcher fails instead of downloading or connecting to remote Mongo. Persistent files remain between restarts, unlike disposable unit-test DBs. Future reopening uses the same local records; no production data is imported.

## Shutdown and cleanup

Press Ctrl+C in the launcher terminal. It closes its own frontend/backend and local mongod and retains data. Do not stop unrelated Node/Mongo processes. If a crash leaves session.lock, the launcher only removes it after establishing its PID is no longer alive; it refuses a live PID. Resolve port conflicts before restarting.

For a reset, first stop the launcher and confirm its ports are closed. Resolve backend/.local-shadow to its absolute path and inspect it; delete only that exact directory with PowerShell Remove-Item -LiteralPath and -Recurse. This deletes local DB/upload/private review state. Do not delete backend/uploads, backend/.env or staging-test-data. No reset/deletion is performed by setup.

## One future real upload

Start with the command above and open the private assignmentUrl. The page is ready for form inspection, but real OCR/provider execution is NOT enabled. Place one newly authorized image at staging-test-data/handwritten-page-01.jpg later. Before submitting, separately authorize and prepare local-only real OCR/normal analysis credentials and a narrowly scoped transport policy plus the one-shot shadow generation ledger/adapter. No broad network unlock, real provider adapter or verifier is part of this task. Stop before pressing Submit Assignment until that later authorized setup is complete. Preserve normal upload validation, credit policy and all shadow semantic/publication restrictions.

For an intentional local reset, after Ctrl+C and confirming all three local listeners have closed, run from the workspace root:

```powershell
$shadowExpected = Join-Path (Resolve-Path -LiteralPath backend).Path '.local-shadow'
$shadowTarget = (Resolve-Path -LiteralPath backend/.local-shadow).Path
if ($shadowTarget -ne $shadowExpected) { throw 'Unexpected cleanup target' }
Get-Item -LiteralPath $shadowTarget | Select-Object FullName, Attributes
# Inspect the printed target before running this final line:
Remove-Item -LiteralPath $shadowTarget -Recurse
```

This command is documentation only and was not executed during setup. Browser verification uses a headless local CI Chrome process with pipe transport and --no-sandbox; this test-only browser setting does not change the application or production PDF browser configuration.
