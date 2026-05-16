# OCR + Writing Corrections Setup

## 1) Install backend dependencies

```bash
cd backend
npm install
```

## 2) Google Vision credentials

Place your JSON service account key somewhere inside the backend folder, for example:

```
backend/credentials/google-vision-account.json
```

Then set the environment variable (add to `.env` or export in your shell):

```bash
GOOGLE_APPLICATION_CREDENTIALS=./credentials/google-vision-account.json
```

## 3) LanguageTool server

Download the latest LanguageTool standalone zip and extract it somewhere, e.g.:

```
backend/tools/LanguageTool-6.5/
```

Run the HTTP server (default port 8081):

```bash
cd backend/tools/LanguageTool-6.5/
java -cp languagetool-server.jar org.languagetool.server.HTTPServer --port 8081
```

Add the URL to your backend `.env`:

```bash
LANGUAGETOOL_URL=http://localhost:8081
LANGUAGETOOL_DEFAULT_LANGUAGE=en-US
LANGUAGETOOL_TIMEOUT_MS=15000
```

## 4) Start the backend

```bash
npm start
```

## 5) Test endpoints

- Handwritten OCR upload (student):
  ```
  POST /api/submissions/upload
  Authorization: Bearer <JWT>
  Content-Type: multipart/form-data
  Body: file=<image>
  ```

- OCR corrections (student/teacher):
  ```
  GET  /api/submissions/:id/ocr-corrections
  Authorization: Bearer <JWT>
  ```

- Writing corrections legend:
  ```
  GET  /api/writing-corrections/legend
  Authorization: Bearer <JWT>
  ```

- Writing corrections check (text):
  ```
  POST /api/writing-corrections/check
  Authorization: Bearer <JWT>
  Content-Type: application/json
  Body: { "text": "your text", "language": "en-US" }
  ```

## 6) Frontend

The Angular app already polls `/api/submissions/:id/ocr-corrections` and expects:

- `ocr[]` pages with `words[]` containing `{id, text, bbox}`
- `corrections[]` with `{wordIds[], bboxList[], category, symbol, color, message, suggestedText, page}`

These are now provided by the backend. No frontend changes required.
