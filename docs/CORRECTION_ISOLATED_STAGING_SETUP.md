# Isolated staging setup handoff (Phase 6.5)

Status: preparation only; no infrastructure provisioned or activated. Phase 7 is blocked. No AI/OCR calls or handwritten upload is permitted during setup.

## Existing deployment evidence

backend/README.md documents Hostinger VPS. backend/docs/PRODUCTION_DOMAIN_CONFIGURATION.md describes CloudPanel/Nginx TLS, Angular static serving and loopback Express. backend/ecosystem.config.js defines the production PM2 process on port 5000. The production Angular backend origin is https://comarkerback.roznahub.com and frontend origin is https://comarkers.roznahub.com. These are repository references, not a live infrastructure audit. The older frontend PM2 configuration points serve at dist, whereas the Angular application build is under dist/rozna-comarker-fe/browser. Confirm the live static-root arrangement before deployment. No usable deployment destination/access is established here. No active Docker/Compose, cloud deployment manifest or CI/CD workflow was found in the application roots.

## Operator evidence required before provisioning

Supply the VPS/hosting account identity and an authorized deployment connection using the existing secure credential mechanism. Confirm the actual live frontend document root, backend release path, PM2 owner, reverse-proxy arrangement and rollback procedure. Select actual staging hostnames through that provider; do not derive or reserve guessed DNS names.

Provide non-secret production Mongo resource/database identities from the hosting owner, and provision a separate staging Mongo project/cluster with separate restricted credentials. A separate explicitly named database with credentials restricted to that database is the minimum alternative. The configured local Mongo URI has no explicit database path; do not reuse it, rely on a driver default database or clone production data. Record both resource IDs, database names and credential-scope evidence without passwords/URIs. No direct production query is needed just to establish this configuration proof.

Uploaded files use local disk, not the Firebase bucket declared in browser configuration: multer and app mounts resolve UPLOAD_BASE_PATH under the backend application root. Use a separate staging backend release and filesystem volume/account; grant its OS identity no write access to the production tree. A different folder name alone is not access isolation. Audit PDF, OCR, cleanup and stored-file consumers in that release for any fixed/default upload roots before accepting isolation. Record resolved paths, mount identities and permissions. Do not point a staging service at production uploads or seed it with production File records.

Provision a separate Firebase Auth project. Current development and production frontend configs both reference rozna-comaker. Do not reuse that project or copy its private keys into staging. Match staging browser firebase configuration, backend service account/project and authorized staging frontend domain. Production identities must not be imported. Shared authentication must be explicitly reviewed and labelled partial isolation, not claimed as full separation.

## Configuration worksheet — not a runnable environment

Create secrets only in the isolated staging secret store or ignored staging release environment after identities are established. Do not copy the current backend .env. The backend loads release-local .env through dotenv; launch with an explicit staging environment and isolated working directory, not the existing production PM2 definition.

Required non-secret settings:

- NODE_ENV=staging
- CORRECTION_PIPELINE_MODE=legacy
- OCR_SOURCE_MODE=legacy
- HOST=127.0.0.1, with a distinct operator-assigned unused internal port
- MONGO_URI: secret for the isolated resource with an explicit staging database name
- UPLOAD_BASE_PATH: isolated relative root inside the staging release/volume, verified against every file consumer
- FRONTEND_URL, PUBLIC_API_URL, BASE_URL, CORS_ALLOWED_ORIGINS and CORS_ORIGINS: actual staging origins only
- FIREBASE_PROJECT_ID/client credentials: separate staging project, private material in the staging secret store
- JWT_SECRET: unique staging secret, never production's secret
- ASSESSMENT_RECOVERY_ENABLED=false during this zero-provider setup
- PAYMENT_PROVIDER=paypal as required by current config; PAYPAL_ENV=sandbox, no production/live credentials, no payment provisioning/checkouts during setup
- SMTP: staging-only mail sink/test inbox with recipient restrictions; never production SMTP credentials or unrestricted real recipients

Do not register configureStagingAdapters or set shadow_v15. Do not add production provider credentials. Existing startup requires AI/OCR configuration and browser runtime checks; do not bypass validators with guessed keys or launch against a real database to see what happens. Resolve staging-only bootstrap prerequisites offline first, and enforce outbound AI/OCR endpoint denial at the staging network boundary during setup. Assessment recovery defaults enabled, and startup unconditionally launches the entitlement worker. Both must operate only on an empty proven-isolated database. Do not launch server.js merely as a health check against an unverified target.

NODE_ENV=staging does not inherit the current production-only security validator or loopback bind default. Explicit loopback binding, TLS proxy restrictions and host/CORS/auth review are required. Current CORS also permits localhost outside production. Restrict origin/network access at the staging proxy and document that behavior; do not claim the code enforces production-equivalent staging restrictions. Production settings must remain untouched.

Angular has development/production builds only, with Firebase and origins compiled into environment files. Prepare an explicit staging replacement in the isolated release after real values are supplied. Reusing the existing production build points at production API/Auth. Inspect the built output to prove all API URL aliases, upload origin, frontend origin and Firebase project are staging-specific. Do not publish a development build with the existing shared Firebase configuration. No staging banner switch was identified; a future staging deployment should use a clear existing hosting/access notice or a narrowly scoped staging indicator. No UI redesign was made here.

## Provision, verify and seed (not executed)

1. Verify owner-approved isolation proof and provider access. Create only staging DB/storage/auth/hostnames and keep production DNS/config untouched.
2. Install the same architecture in separate release paths with the explicit staging settings, private network policy and unique secrets. Verify required indexes using the existing index contracts on staging only. Do not run production migrations or clone student data.
3. Serve the actual staging frontend artifact through a new staging virtual host and proxy only to staging Express. Verify frontend, API health and browser network destinations. Record actual URLs and TLS/resource identities; loading a production URL is not a staging test.
4. Use a tiny harmless staging-only storage probe after verifying the destination. Confirm its canonical path/resource and permission boundary; remove that exact probe afterward. Do not write or probe production. Record evidence and label any production comparison as configuration-only when not directly checked.
5. Create synthetic staging teacher/student accounts through normal signup/Firebase paths, completing human email verification where required. Keep passwords/tokens out of reports. Configure valid synthetic plan/credit entitlements through supported staging admin paths, not by disabling policy.
6. Through normal UI create one teacher-owned class and writing assignment; join/access as the staging student. Record actual IDs privately and verify the upload form without submitting a file. No automatic exhaustive gold or semantic approval is created.
7. Keep provider traffic at zero. If signup/assignment creation unexpectedly invokes AI/OCR, stop; do not relax the network guard or consume Phase-7 budget.
8. Accept exactly one new authorized handwritten image in staging-test-data later. Until then HANDWRITTEN_TEST_IMAGE_PATH=PENDING_USER_FILE. Do not use Golden001 or production work.
9. Record all readiness prerequisites and leave correction mode legacy with no adapter. Any missing prerequisite means PHASE7_READY=false. Only then resume the separately authorized bounded Phase-7 exercise.

Rollback for staging provisioning is stop the staging-only services and remove/revert only their verified resources/config. Do not execute existing production PM2 restart, change production DNS or overwrite its .env. Shadow is inactive throughout setup, so no experimental score/publication state exists to undo.
