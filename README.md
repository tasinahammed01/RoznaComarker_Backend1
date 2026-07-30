# Backend Foundation (Node.js + Express + MongoDB)

## Overview
A clean, production-ready backend foundation using Node.js, Express (JavaScript/CommonJS), and MongoDB (Mongoose). Includes security headers, request logging, global rate limiting, consistent error handling, and a health check endpoint.

This backend includes:
- Firebase login -> backend JWT
- RBAC (`admin`, `teacher`, `student`)
- Classes, memberships, assignments, submissions, feedback
- File uploads (stored on disk, served via `/uploads/...`)
- Subscription plans & usage limits
- Swagger API docs

## Install
1. Create a `.env` file based on `.env.example`.
2. Install dependencies:

```bash
npm install
```

## Environment (.env)

- Copy `.env.example` -> `.env`
- Fill in required variables (`MONGO_URI`, `JWT_SECRET`, Firebase service account values)

All AI-backed features use one global gateway configuration:

- `AI_PRIMARY_PROVIDER` / `AI_PRIMARY_MODEL`
- `AI_FALLBACK_1_PROVIDER` / `AI_FALLBACK_1_MODEL` (optional)
- `AI_FALLBACK_2_PROVIDER` / `AI_FALLBACK_2_MODEL` (optional)
- `AI_FALLBACK_3_PROVIDER` / `AI_FALLBACK_3_MODEL` (optional)
- `AI_RETRIES_PER_MODEL`
- `AI_ATTEMPT_TIMEOUT_MS`
- `AI_TOTAL_BUDGET_MS`
- `AI_RETRY_DELAY_MS`
- Provider credentials and base URLs, such as `GEMINI_API_KEY`,
  `OPENROUTER_API_KEY`, `GEMINI_BASE_URL`, and `OPENROUTER_BASE_URL`

Changing the global provider/model chain affects rubric, semantic analysis,
adaptive practice, flashcard, and worksheet generation consistently. See
`.env.example` for the complete canonical configuration and supported provider
names. Legacy feature-specific provider/model variables are not used.

Notes:
- `NODE_ENV=production` requires `FRONTEND_URL`.
- Uploads are stored on disk under `UPLOAD_BASE_PATH` and served at `GET /uploads/...`.

## Run (Development)

```bash
npm run dev
```

## Run (Production)

```bash
npm start
```

## API Documentation (Swagger)

- Swagger UI: `GET /api/docs`
- OpenAPI JSON: `GET /api/docs.json`

## Database seeding (plans)

On server start, the backend calls `Plan.seedDefaults()` automatically. This ensures the default plans exist:
- Free
- Pro
- School

Subscription usage is initialized lazily when a user authenticates.

## Running tests

```bash
npm test
```

Notes:
- Tests use `mongodb-memory-server` (in-memory MongoDB).
- `JWT_SECRET` is set to a test value if not provided.
- Tests do not require Firebase credentials because they do not call `/api/auth/login`.

## Deploying to Hostinger VPS (notes)

High-level steps:

1. Install Node.js (LTS) and MongoDB (or use MongoDB Atlas).
2. Upload the `backend/` folder to the server.
3. Create `.env` on the server.
4. Install dependencies: `npm install --omit=dev`
5. Start the server using a process manager (recommended: PM2) or systemd.
6. Configure a reverse proxy (Nginx/Apache) to forward traffic to `PORT`.

File uploads:
- Ensure the process user has write permissions to `UPLOAD_BASE_PATH`.
- Uploaded files are stored on disk and served via `GET /uploads/<type>/<filename>`.
- If you change `UPLOAD_BASE_PATH`, ensure the folder exists and is persistent.

## Health Check

- Endpoint: `GET /api/health`
- Example response:

```json
{
  "success": true,
  "status": "OK",
  "environment": "development",
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```
