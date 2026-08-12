# RoznaComarker production security runbook

Status: repository guidance and safeguards are implemented. No VPS, CloudPanel,
DNS, Atlas, Stripe, Firebase, or provider setting has been changed or verified
by this repository work. Complete every applicable manual gate below before
calling the deployment production-ready.

## 1. Confirmed architecture and boundaries

Expected flow:

```text
Internet -> optional Cloudflare -> CloudPanel/Nginx
  -> Angular static files (comarkers.roznahub.com)
  -> Express loopback:5000 (comarkerback.roznahub.com)
     -> MongoDB Atlas and Stripe/Firebase/Google/AI/SendGrid/Unsplash HTTPS APIs
```

Repository-confirmed facts:

- Express waits for MongoDB connection and PDF runtime validation before listening.
- Production defaults to `127.0.0.1:5000`; an explicit non-loopback production
  `HOST` fails validation. Development still defaults to `0.0.0.0`.
- Express trusts exactly one proxy hop. CORS permits exactly the production
  frontend origin. Rate limits and concurrency controls are process-local.
- PM2 is explicitly one fork-mode instance. Do not use cluster mode until a
  Redis-backed limiter, distributed concurrency control, and SSE/accounting
  design are deployed.
- Private assignment/submission/feedback files remain behind authenticated
  handlers. Only the existing avatar, class-banner, flashcard, and template
  asset routes are static.
- Persistent local data is under `UPLOAD_BASE_PATH` (default `backend/uploads`).
  PDF work files use the OS temporary directory under `rozna-pdf`.
- `/api/notifications/stream` is SSE. `/api/stripe/webhook` must remain public
  to Stripe and retains its raw-body/signature handling.
- The public health response contains status, time, environment and versioned
  contract identifiers, not credentials or connectivity details.
- Angular production output is `dist/rozna-comarker-fe/browser`; production
  source maps are not enabled by the current Angular configuration.
- `.env`, `key/`, uploads, logs, private keys and service-account JSON files are
  ignored. The backend source tree must not be an Nginx static root.

Not confirmed locally: active listeners, OS/version, CloudPanel vhosts, TLS
chain/renewal, firewall/provider rules, SSH port/settings, PM2 service owner,
Atlas allowlist/users/backups, backup jobs, DNS, MFA, monitoring, disk capacity,
or production CSP violations.

## 2. Nginx and CloudPanel

Use `deploy/nginx/rozna-comarker.conf.example` as a reviewed merge template.
Do not replace a CloudPanel-generated vhost wholesale. Locate active files with:

```bash
sudo nginx -T | less
sudo nginx -T 2>&1 | grep -nE 'server_name (comarkers|comarkerback)\.roznahub\.com'
```

In CloudPanel confirm both sites, the frontend document root, the backend proxy
to `127.0.0.1:5000`, certificate and renewal status, site/log ownership, and
that PHP is not attached to these Node/static sites. Apply the template's
directives inside the appropriate HTTPS blocks. Keep CloudPanel's ACME location.

The proxy intentionally overwrites `X-Forwarded-For` with the edge-observed
client address. This prevents a direct client from injecting a trusted address
and matches Express `trust proxy = 1`. With Cloudflare, first configure Nginx
`real_ip_from` using every current official Cloudflare range and
`real_ip_header CF-Connecting-IP`, then block direct origin access. Only then
will `$remote_addr` safely represent the visitor.

The 52 MiB edge limit accommodates multipart overhead while Express remains
authoritative for 10 MiB/file and 50 MiB aggregate limits. General 300-second
timeouts cover the current 200-second AI budget and bounded PDF work. Only SSE
gets one-hour streaming timeouts and buffering disabled.

Frontend static headers belong to Nginx. API-specific Helmet headers remain in
Express. Nginx hides the upstream HSTS value and emits one conservative
15552000-second value; do not add `preload`. CSP remains **Report-Only**. Do not
enable enforcement until production-like Stripe embedded checkout, Firebase,
fonts, Unsplash, blob workers, and all main workflows have clean reviewed
telemetry. Initially collect sampled CSP violations in restricted Nginx logs or
an external bounded reporting service; do not expose an unlimited application
report collector.

Before every change:

```bash
sudo cp /path/to/active-vhost.conf /root/secure-config-backups/vhost.$(date +%Y%m%d%H%M%S).conf
sudo nginx -t
sudo systemctl reload nginx
```

Run the reload only when `nginx -t` succeeds. Keep secret-bearing backups root
readable and outside the repository. Roll back by restoring the known-good copy,
running `nginx -t`, and reloading. Use generic 4xx/5xx pages; never expose paths,
upstream details, `.git`, `.env`, keys, backups, logs, `node_modules`, uploads,
or directory indexes. Uploaded files must never be mapped to PHP/CGI execution.

TLS gates: valid complete chains for both names, HTTP-to-HTTPS redirects, TLS
1.2+, CloudPanel-supported modern defaults, and tested automatic renewal. Avoid
hand-maintained exotic cipher lists.

## 3. Firewall and SSH (lockout-safe order)

Discover before changing anything:

```bash
sudo sshd -T | grep -E '^(port|permitrootlogin|passwordauthentication|maxauthtries) '
sudo ss -tulpn
sudo ufw status verbose
```

Create a non-root deployment user, add only current public keys, confirm a fresh
key-based SSH login and `sudo`, and keep the recovery session open. Then allow
the discovered SSH port before enabling any firewall:

```bash
sudo ufw allow <ACTUAL_SSH_PORT>/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status numbered
```

Expected public ports are 80 (redirect/ACME), 443, and the confirmed restricted
SSH port. Node 5000, MongoDB 27017, Redis 6379 and PM2 internals must not be
public. Restrict the discovered CloudPanel management port to a fixed admin IP
or VPN at both UFW and the Hostinger provider firewall; do not assume its port.
Use both firewall layers as defense in depth and keep their rules consistent.

Only after all four SSH safety checks succeed, create a small sshd drop-in with
`PermitRootLogin no`, `PasswordAuthentication no`, and a reasonable
`MaxAuthTries` (for example 4), then run `sudo sshd -t` and reload SSH without
closing the recovery session. Fail2Ban is useful primarily for SSH if provider
controls do not already cover it; use conservative thresholds because schools
share NAT addresses.

## 4. PM2, runtime and file permissions

Use a dedicated application account, never root. The repository PM2 file is
portable, one-instance fork mode, restart-delayed, graceful-shutdown-aware, and
has a 1 GiB memory restart guard. That guard is an initial ceiling, not a claim
about measured requirements; alert and tune it after observing Chromium/PDF
peaks. Repeated crashes require investigation, not a larger restart loop.

```bash
sudo -iu <APP_USER>
cd /path/to/backend
mkdir -p uploads
npm ci --omit=dev
pm2 start ecosystem.config.js
pm2 save
pm2 status
pm2 startup systemd -u <APP_USER> --hp /home/<APP_USER>
```

Run the exact root command printed by `pm2 startup`, then `pm2 save` again as
the app user. `tsx` is now a production dependency because the server requires
`tsx/cjs` at runtime. Use the Node version tested in CI/deployment; this checkout
runs Node 22.13.1 and Angular requires a compatible supported Node release. Do
not major-upgrade production without the full regression suite.

Install PM2 log rotation manually if it is not already managed by journald:

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 20M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
pm2 set pm2-logrotate:dateFormat YYYY-MM-DD_HH-mm-ss
pm2 set pm2-logrotate:rotateInterval '0 0 * * *'
```

Keep `.env` mode `600`, source/config mode normally `640/750`, credential JSON
mode `400` or `600`, uploads `750` directories and `640` files, all owned by the
app user/group. Never use `777`. PM2 logs in the app user's `~/.pm2/logs` must
not be web served. The app user needs read/write only for uploads, PM2 state and
required temp paths. Keep Chromium sandboxing enabled (`PDF_CHROME_NO_SANDBOX=false`);
if a host forces `--no-sandbox`, treat that as an unresolved isolation risk.

## 5. Atlas, secrets and backups

Atlas Network Access should allow the stable VPS egress IP only for production.
Remove `0.0.0.0/0`. Maintain a separate, temporary/narrow development IP entry
when needed. The application database user needs `readWrite` on only the Rozna
application database (including index management used at startup), not Atlas
project owner, admin or root. Atlas connections remain TLS `mongodb+srv` and
the URI stays server-only.

Confirm the selected Atlas tier actually provides automated snapshots, record
schedule/retention, alert on failures, and perform a quarterly restore into a
separate temporary database. Verify representative users, classes, assignments,
submissions and indexes, then securely remove the test database. Never restore
over production as a test.

Mongo snapshots do not cover local uploads. Back up the persistent upload root
daily to a trusted encrypted off-server repository using a dedicated write-only
credential where supported. A starting retention policy is 7 daily, 4 weekly,
and 6 monthly copies, adjusted to legal/school requirements. Exclude regenerated
OS temp PDFs and caches. Quarterly restore to a separate locked path and verify
manifest hashes and representative authorized downloads. Backup credentials and
copies must not be world-readable.

Store `.env` and Google credentials outside Git and outside static roots. PM2's
committed ecosystem contains no secrets. Rotation checklist:

- JWT: deploy a new secret; current design invalidates all existing app JWTs.
- Mongo: create/validate a least-privilege replacement credential, deploy it,
  then revoke the old credential.
- Stripe secret/webhook: stage replacement values and endpoint secrets, verify
  signed test events, then revoke old values. Do not switch live mode here.
- AI/OpenRouter/Google/SendGrid: issue least-privilege replacements, deploy and
  smoke test, then revoke old keys. Remove leaked service-account keys entirely.

Never print secret values in shell history, PM2 config, tickets, backups, or
logs. Preserve current log sanitization; do not log tokens, OTPs, student text,
complete webhook payloads, authorization headers, Mongo URIs or provider keys.

## 6. Optional Cloudflare, DNS, email and accounts

Cloudflare is optional. If enabled, use proxied DNS, Full (Strict) TLS, managed
WAF and modest endpoint-specific limits. Exempt `/api/stripe/webhook` from JS
challenges/CAPTCHA and generic bot limits; Stripe signature validation remains
authoritative. Do not IP-allowlist Stripe unless implementing Stripe's current
official guidance. Avoid aggressive edge limits for classroom NAT traffic.

Review both DNS names and remove stale records, especially unclaimed third-party
CNAMEs (subdomain takeover risk). Configure SPF, DKIM and DMARC only with the
exact records generated for the real SendGrid sender domain. Require MFA for
Hostinger, CloudPanel, Atlas, Stripe, Google/Firebase, Git hosting, SendGrid and
Cloudflare. Keep deployment, database application, Git deploy and administrator
accounts separate and least privileged.

## 7. Monitoring, capacity and maintenance

Minimum alerts and first-pass thresholds (tune from baselines):

- HTTPS health failure twice over 2 minutes; sustained 5xx above 2% for 5 minutes.
- CPU above 85% for 10 minutes; memory above 85% or any PM2 memory restart.
- disk above 75% warning and 85% critical; separately trend upload and PM2-log size.
- Mongo connection/startup failure; Stripe webhook 4xx/5xx; repeated AI provider
  failures; unusual AI cost/usage; spikes in 401/403/429.
- certificate expiry under 21 days; failed renewal; failed/missing daily backup;
  quarterly restore test overdue.

Use external uptime checks for `/api/health` and the frontend, host metrics from
Hostinger/CloudPanel or a small agent, PM2 status/log rotation, Atlas alerts, and
provider dashboards. Do not put secrets or full student content in alert payloads.
Review `df -h`, `du -sh uploads ~/.pm2/logs`, memory and zombie Chromium processes.
Clean only confirmed stale OS temp artifacts; never automatically purge active
user uploads. Apply OS security updates in a maintenance window, review held
packages/kernel reboot needs, test, and keep a rollback/snapshot plan.

## 8. Production verification

From the VPS:

```bash
sudo nginx -t
sudo ss -tulpn
sudo ufw status verbose
ps -o user,pid,ppid,cmd -C node
pm2 status
df -h
du -sh /path/to/backend/uploads ~/.pm2/logs
curl -fsS http://127.0.0.1:5000/api/health
```

From a separate authorized machine:

```bash
curl -I http://comarkers.roznahub.com
curl -I https://comarkers.roznahub.com
curl -I http://comarkerback.roznahub.com/api/health
curl -i https://comarkerback.roznahub.com/api/health
curl -i -H 'Origin: https://comarkers.roznahub.com' https://comarkerback.roznahub.com/api/health
curl -i -H 'Origin: https://evil.example' https://comarkerback.roznahub.com/api/health
node scripts/verify-production-security.js --live --server-ip <VPS_PUBLIC_IP>
```

Port 5000 must time out/refuse externally. On your own VPS only, an authorized
bounded `nmap -sT -Pn <VPS_PUBLIC_IP>` should show only intended public services.
Do not scan third parties or run production stress tests.

Manually verify an anonymous private-file compatibility URL is denied and an
authorized participant succeeds. Perform only a small, controlled rate-limit
smoke test on a low-risk test account/route and confirm 429 without load testing.
Confirm SSE remains connected and reconnects, OCR/AI/PDF requests complete within
the edge timeout, Stripe test-mode webhook requests reach
`/api/stripe/webhook` without JWT/WAF challenge and retain valid signatures, and
the frontend domain is authorized in the intended Firebase project.

## 9. Ordered deployment and rollback checklist

1. Take provider snapshot/config backups and record current DNS/listeners.
2. Create/test the non-root user, key SSH and sudo in a second session.
3. Install the tested Node runtime and deploy from the lockfile. Build Angular
   with build tooling, then publish only `dist/rozna-comarker-fe/browser`.
4. Set protected production `.env` including `HOST=127.0.0.1`; place Google
   credentials outside Git/static roots; create/permission the upload root.
5. Start one backend PM2 fork as the app user; verify loopback health and graceful
   restart, configure startup restore and log rotation.
6. Back up and merge the Nginx template into CloudPanel vhosts. Validate, reload,
   then verify TLS, redirects, headers, CSP Report-Only, SSE and long requests.
7. Confirm actual SSH/CloudPanel ports, allow SSH/80/443 first, then apply UFW and
   provider rules. Restrict management and confirm 5000 is externally closed.
8. Restrict Atlas IP/user permissions and verify application startup. Confirm
   Atlas and encrypted upload backup jobs plus separate restore procedures.
9. Configure monitoring, certificate/backup alerts, MFA, Firebase domain and
   SendGrid-provided email DNS. Review CSP telemetry before any future enforcement.
10. Run every command/check in section 8 and record evidence.

Rollback application/config changes by deploying the last known-good release and
environment backup, `pm2 reload RoznaComarker_Backend`, restoring the prior Nginx
vhost, running `sudo nginx -t`, then reloading. Do not roll back security by
opening 5000, widening Atlas to the world, disabling signature verification, or
serving private uploads directly.

## 10. Incident mini-runbook

- Leaked provider key: revoke/rotate, deploy, test, review access logs and billing.
- Leaked JWT secret: rotate, accept forced sign-in, investigate token exposure.
- Leaked Mongo credential: restrict network access, rotate the DB user, inspect audit logs.
- Leaked Google key: disable/delete the service-account key, replace and review use.
- Compromised server: isolate it at provider firewall, preserve snapshot/logs,
  rotate all reachable credentials, rebuild from a clean image, restore only
  verified data, validate, then return traffic.

Production gate remains **NO-GO** until the unconfirmed manual controls in this
runbook have been applied and evidenced, especially TLS renewal, SSH/firewall,
external closure of port 5000, Atlas restrictions, backups/restores, and alerts.
