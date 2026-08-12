# Production domain configuration

In production, Nginx serves the Angular build directly and proxies the public
API origin to Express on loopback. Keep public origins canonical (no trailing
slash); URL variables must never point to the internal socket.

Set these values in the untracked production environment:

```text
NODE_ENV=production
HOST=127.0.0.1
PORT=5000
PUBLIC_API_URL=https://comarkerback.roznahub.com
BASE_URL=https://comarkerback.roznahub.com
FRONTEND_URL=https://comarkers.roznahub.com
CORS_ALLOWED_ORIGINS=https://comarkers.roznahub.com
CORS_ORIGINS=https://comarkers.roznahub.com
```

Terminate TLS at CloudPanel/Nginx and proxy the backend domain to the internal
backend port. Preserve the original host and scheme, and normalize the client
address as described in `PRODUCTION_SECURITY.md`. The app
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

Add `comarkers.roznahub.com` to Firebase Authentication **Authorized domains**.
Keep localhost only for intentional development use. Do not add the backend
domain unless a browser authentication redirect is later introduced there.

Before production use, rotate any credentials that were previously exposed,
including MongoDB, Firebase service-account, JWT, OpenRouter, Gemini, and
Unsplash secrets. Keep `.env`, service-account JSON, and API keys untracked.
