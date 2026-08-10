# Production domain configuration

The Angular build is served locally at `http://localhost:4200` and
the Express origin is `http://localhost:5000`. Keep origins
canonical (no trailing slash). The backend continues listening on its internal
`PORT`; public URL variables must not point at that internal socket.

Set these values in the untracked production environment:

```text
NODE_ENV=production
PORT=5000
PUBLIC_API_URL=http://localhost:5000
BASE_URL=http://localhost:5000
FRONTEND_URL=http://localhost:4200
CORS_ALLOWED_ORIGINS=http://localhost:4200
CORS_ORIGINS=http://localhost:4200
```

Terminate TLS at CloudPanel/Nginx and proxy the backend domain to the internal
backend port. Preserve the original host, scheme, and client address. The app
trusts one proxy hop in production, so the deployment must keep exactly one
trusted reverse-proxy hop in front of Node.

For the notification SSE route, include:

```nginx
proxy_http_version 1.1;
proxy_buffering off;
proxy_cache off;
proxy_read_timeout 3600;
```

Normal API, multipart upload, static `/uploads/`, and PDF routes should proxy to
the same internal backend. Allow request bodies large enough for the existing
upload limits. `PUBLIC_API_URL` ensures generated upload/image links use the
public HTTPS backend origin. PDF rendering reads validated uploaded assets from
the configured local upload root, so it does not depend on a localhost public
URL.

Add `localhost` in Firebase Authentication **Authorized domains**.
Do not add the backend domain unless a browser authentication redirect is later
introduced there.

Before production use, rotate any credentials that were previously exposed,
including MongoDB, Firebase service-account, JWT, OpenRouter, Gemini, and
Unsplash secrets. Keep `.env`, service-account JSON, and API keys untracked.
