# Submission Feedback PDF production checklist

## Runtime

- Use Node.js 22 LTS and `npm ci`; do not install with `--ignore-scripts` or `PUPPETEER_SKIP_DOWNLOAD=true` unless a validated system Chromium path is configured.
- Confirm `puppeteer` is installed as a production dependency and run `node -e "require('./src/services/pdfBrowserManager.service').validateBrowserRuntime()"` in the deployed image.
- Set `PDF_REPORT_ENGINE=puppeteer`. The legacy generator is retained for rollback but is not an automatic fallback.
- Prefer Puppeteer's bundled Chrome. Set `PUPPETEER_EXECUTABLE_PATH` only when the deployment image deliberately supplies a compatible Chromium executable.
- Provide at least 1 GB memory for the default concurrency of two; use 2 GB for ten-page or concurrent reports.
- Ensure the configured uploads root is mounted read-only for the application where operationally possible and the temporary directory is writable.

## Recommended configuration

```text
PDF_REPORT_ENGINE=puppeteer
PDF_MAX_CONCURRENT_RENDERS=2
PDF_RENDER_QUEUE_LIMIT=8
PDF_QUEUE_WAIT_TIMEOUT_MS=15000
PDF_RENDER_TIMEOUT_MS=60000
PDF_PAGE_READY_TIMEOUT_MS=15000
PDF_IMAGE_LOAD_TIMEOUT_MS=15000
PDF_ASSET_TIMEOUT_MS=30000
PDF_MAX_UPLOADED_PAGES=20
PDF_MAX_IMAGE_DIMENSION=12000
PDF_MAX_DECODED_ASSET_BYTES=26214400
PDF_MAX_HTML_BYTES=12582912
PDF_MAX_TRANSCRIPT_CHARACTERS=1000000
UPLOAD_BASE_PATH=uploads
```

## Deployment

1. Run `npm ci` in the backend deployment image and verify the browser cache is retained in the final runtime layer.
2. Start the application in staging. Startup must fail if no usable browser is resolved.
3. Run `node scripts/generateProductionSubmissionFeedbackPdf.js` and render it with `node scripts/renderSampleSubmissionFeedbackPdf.js ../output/pdf/RoznaHub-Production-Submission-Feedback-Report.pdf production-submission-feedback`.
4. Run `node scripts/verifyProductionPdfVisualRegression.js` without updating the approved baseline.
5. Generate a report through both an authorized student session and the owning teacher session for the same staging submission.
6. Compare safe diagnostics, source hashes, correction counts, PDF page count, and database snapshots before and after both downloads.
7. Monitor `METRIC` events for render duration, failures, browser restarts, queue wait, active count, submitted page count, and output bytes.

## Production smoke test

Use a designated non-sensitive smoke-test submission. Confirm HTTP 200, `application/pdf`, fixed attachment filename, private no-store caching, `nosniff`, correct file/page annotations, current scores, and no database changes. Do not use health checks to generate student reports.

## Rollback

1. Redeploy the previous known-good application release and package lock as one atomic release.
2. Do not switch automatically to the legacy generator: it does not meet the current read-only and data-consistency requirements.
3. Keep the PDF endpoint temporarily unavailable with a controlled 503 if the previous secure release cannot be restored.
4. Preserve safe failure metrics and the affected opaque submission identifiers for investigation; never retain report HTML, student text, or image bytes in logs.
