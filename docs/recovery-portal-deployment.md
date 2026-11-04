# Recovery portal: deployment

The multi-assignment recovery portal (`/api/recovery/*`, frontend `/recover` and `/recover/portal`) needs one database step on
each environment, because the application connects with `autoIndex: false, autoCreate: false` (`src/config/db.js`) and therefore
never creates indexes itself.

## 1. Create the indexes (once per environment, safe to repeat)

```bash
cd backend
npm run migrate:recovery-portal-indexes
```

It uses `MONGO_URI` from the environment (or `backend/.env`), only **adds missing** indexes, never drops or rewrites one, and prints
the resulting index list. Expected TTL indexes:

| Collection | Index | TTL |
|---|---|---|
| `recoverytokens` | `recovery_token_purge_v1` on `purgeAt` | 0 s (document removed at `purgeAt` = link expiry + 7 days) |
| `recoverysessions` | `recovery_session_purge_v1` on `expiresAt` | 3600 s after the session expires |
| `recoveryemailwindows` | `recovery_email_window_purge_v1` on `expiresAt` | 0 s (hourly email counters) |
| `recoverylinkaudits` | `recovery_link_audit_ttl_v1` on `createdAt`, created by `npm run migrate:annotation-indexes` and this script | 1 year (teacher-sent link audit rows are removed after 365 days) |

Plus the unique `recovery_token_hash_v1` (`tokenHash`) and `recovery_session_hash_v1` (`sessionHash`), and lookup indexes
`recovery_token_email_v1` and `recovery_session_token_v1`.

Equivalent mongosh commands, if the script cannot be run:

```js
db.recoverytokens.createIndex({ tokenHash: 1 }, { unique: true, name: 'recovery_token_hash_v1' });
db.recoverytokens.createIndex({ emailNormalized: 1, createdAt: -1 }, { name: 'recovery_token_email_v1' });
db.recoverytokens.createIndex({ purgeAt: 1 }, { expireAfterSeconds: 0, name: 'recovery_token_purge_v1' });
db.recoverysessions.createIndex({ sessionHash: 1 }, { unique: true, name: 'recovery_session_hash_v1' });
db.recoverysessions.createIndex({ tokenId: 1 }, { name: 'recovery_session_token_v1' });
db.recoverysessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 3600, name: 'recovery_session_purge_v1' });
db.recoveryemailwindows.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'recovery_email_window_purge_v1' });
db.recoverylinkaudits.createIndex({ submissionId: 1, createdAt: -1 }, { name: 'recovery_link_audit_submission_v1' });
db.recoverylinkaudits.createIndex({ issuedBy: 1, createdAt: -1 }, { name: 'recovery_link_audit_teacher_v1' });
```

Without these the portal still works (the per-address email cap uses the `_id` primary key and is atomic either way), but expired
links, sessions and counters are never removed and the token/session lookups scan their collection.

## 2. Configuration (optional; defaults shown)

```
RECOVERY_LINK_TTL_HOURS=24      # 1-168
RECOVERY_LINK_MAX_USES=10       # 1-100
RECOVERY_SESSION_MINUTES=30     # 5-240
RECOVERY_EMAILS_PER_HOUR=3      # 1-20 emails per address per clock hour, atomic (shared with the link resend)
RECOVERY_EMAIL_COOLDOWN_SECONDS=120  # 30-3600, one recovery email per address per cool-down (shared, atomic)
RECOVERY_REQUESTS_PER_HOUR=10   # 3-100 HTTP requests per address per hour on every recovery endpoint
RECOVERY_TEACHER_SENDS_PER_HOUR=20  # 1-200 teacher-sent recovery links per teacher per hour (atomic)
```

The portal follows `GUEST_SUBMISSION_ENABLED` (off means off) and needs working SMTP and an https `FRONTEND_URL` in production.

## 3. Frontend

Build with `npm run build:prod` (see `RoznaComarker/DEPLOYMENT.md`).
