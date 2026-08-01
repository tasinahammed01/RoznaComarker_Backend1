# Runtime contract deployment verification

The backend exposes its loaded assessment contract fingerprint at `GET /api/health`. The diagnostic-only `APP_DEPLOYMENT_REVISION` may contain a Git commit, release ID, or deployment timestamp. Local development may leave it empty; it resolves to `local`.

## Local Windows restart

1. Identify the listener with `Get-NetTCPConnection -LocalPort 5000 -State Listen` or `netstat -ano | Select-String ':5000'`.
2. Confirm its PID and command line. Stop only that PID with `Stop-Process -Id <verified-pid>`.
3. From `D:\Client Project Fiverr\1st project\ProjectRozna\backend`, run `npm start`.
4. Request `http://localhost:5000/api/health`.
5. Run `npm run verify:runtime`.
6. Accept uploads only after verification succeeds and exactly one intended process owns port 5000.

Never use `taskkill /IM node.exe`; Angular and other Node processes may be running.

## Production PM2 restart

1. Pull the intended revision and install/build as required.
2. Set `APP_DEPLOYMENT_REVISION` to that exact revision.
3. Run `pm2 restart <exact-process-name> --update-env`.
4. Wait for the existing health route to return HTTP 200.
5. Request the configured `/api/health` route and run `RUNTIME_HEALTH_URL=<health-url> npm run verify:runtime`.
6. Confirm the intended process alone owns the application port.
7. Run `pm2 save` only after runtime verification succeeds.

Do not use broad `pkill node`, `killall node`, or unrelated PM2 process names.
