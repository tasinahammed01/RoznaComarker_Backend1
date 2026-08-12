'use strict';

const mammoth = require('mammoth');
const path = require('path');
const aiGateway = require('./aiGateway.service');
const { sanitizeWorksheetHtml } = require('./worksheetHtmlSanitizer.service');

function cleanHtmlResponse(raw) {
  return String(raw || '').trim()
    .replace(/^```html\s*/iu, '').replace(/^```\s*/u, '').replace(/\s*```\s*$/u, '').trim();
}

function extractTitle(html) {
  const match = String(html || '').match(/<title[^>]*>([^<]+)<\/title>/iu)
    || String(html || '').match(/<h1[^>]*>([^<\n]+)<\/h1>/iu);
  return match ? match[1].trim().replace(/&amp;/gu, '&') : 'Generated Worksheet';
}

function containsExecutableHtml(html) {
  return /<\s*script\b|javascript\s*:|\bon\w+\s*=/iu.test(String(html || ''));
}

function buildGeminiPrompt(options = {}) {
  const {
    subject = 'General', gradeLevel = '', gradeCategory = '', difficulty = 'medium',
    language = 'English', cefrLevel = '',
    activityTypes = ['ordering', 'classification', 'multipleChoice', 'fillBlanks'],
    theme = 'modern'
  } = options;
  const activityList = Array.isArray(activityTypes) ? activityTypes.join(', ') : String(activityTypes);
  const themeGuidance = {
    modern: 'teal/cyan palette (#008081 primary), clean sans-serif fonts, subtle card shadows',
    classic: 'dark navy (#1e293b), serif fonts, clean lines',
    corporate: 'deep blue (#1e40af), professional sans-serif, structured grid layout',
    academic: 'purple (#7c3aed), formal academic feel, clear hierarchy',
    futuristic: 'cyan (#06b6d4) on dark navy (#0f172a), tech-style'
  };
  const themeHint = themeGuidance[theme] || themeGuidance.modern;
  return `You are an expert educational worksheet designer.

Analyze the provided file content carefully. Then create a complete, visually polished, print-ready worksheet for students.

CONTEXT PROVIDED BY TEACHER:
- Subject: ${subject || 'General'}
- Grade Level: ${gradeLevel || 'Not specified'}
- Grade Category: ${gradeCategory || 'Not specified'}
- Difficulty: ${difficulty}
- Language: ${language}
- CEFR Level: ${cefrLevel || 'Not specified'}
- Activity Types to include: ${activityList}
- Visual theme: ${theme} (${themeHint})

WORKSHEET DESIGN REQUIREMENTS:
1. Identify the main topic from the file content
2. Create a structured, complete worksheet including:
   - A colored header section with the worksheet title and subject
   - A student info row: "Name: ____________  Date: ____________  Class: ____________"
   - A brief concept explanation box (key vocabulary or background info from the content)
   - Clearly separated activity sections that match the selected Activity Types:
       • "ordering" → Ordering / Sequencing activity
       • "classification" → Classification / Sorting activity
       • "multipleChoice" → Multiple Choice questions
       • "fillBlanks" → Fill in the Blanks sentences
       • "matching" → Matching Pairs activity
       • "trueFalse" → True or False statements
       • "shortAnswer" → Short Answer questions
   - Each activity must have a numbered section header, clear instructions, and answer boxes/lines
3. Use ONLY inline CSS and a single <style> block inside <head> — no external CSS, no Google Fonts imports
4. The worksheet must be A4 width (794px) and look professional when printed
5. Root element: <html> with a <body> that has a top-level <div class="worksheet-container">
6. Color scheme: follow the theme hint above; use a colored header gradient

OUTPUT RULES — READ CAREFULLY:
- Return ONLY raw HTML starting with <!DOCTYPE html>
- Do NOT include markdown code fences
- Do NOT include executable scripts, javascript URLs, or event-handler attributes
- Do NOT include any explanation, comments outside HTML, or preamble
- The entire response must be valid, self-contained HTML`;
}

function validateHtml(rawHtml, activityTypes) {
  const html = cleanHtmlResponse(rawHtml);
  if (html.length < 100 || !/^<!doctype html>/iu.test(html)
    || !/<html\b/iu.test(html) || !/<body\b/iu.test(html)
    || !/class=["'][^"']*\bworksheet-container\b/iu.test(html)) {
    const error = new Error('AI returned an invalid worksheet.');
    error.code = 'WORKSHEET_HTML_INVALID';
    throw error;
  }
  const sanitizedHtml = sanitizeWorksheetHtml(html);
  const requested = Array.isArray(activityTypes) ? activityTypes.filter(Boolean) : [];
  if (requested.length) {
    const normalized = sanitizedHtml.toLowerCase();
    const labels = {
      ordering: ['ordering', 'sequencing'], classification: ['classification', 'sorting'],
      multipleChoice: ['multiple choice'], fillBlanks: ['fill in the blank', 'fill-in-the-blank'],
      matching: ['matching'], trueFalse: ['true or false', 'true/false'], shortAnswer: ['short answer']
    };
    const missing = requested.filter((type) => !(labels[type] || [type])
      .some((label) => normalized.includes(label.toLowerCase())));
    if (missing.length) {
      const error = new Error('AI worksheet omitted required activity types.');
      error.code = 'WORKSHEET_ACTIVITY_COUNT_MISMATCH';
      throw error;
    }
  }
  return sanitizedHtml;
}

async function generateHtmlWorksheetFromFile(fileBuffer, mimeType, fileName, options = {}) {
  if (!Buffer.isBuffer(fileBuffer)) throw new Error('Worksheet file buffer is required.');
  const ext = path.extname(fileName || '').toLowerCase().replace('.', '');
  const isDocx = mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    || mimeType === 'application/msword' || ['docx', 'doc'].includes(ext);
  const isTxt = mimeType === 'text/plain' || ext === 'txt';
  const isPdf = mimeType === 'application/pdf' || ext === 'pdf';
  const isImage = ['image/png', 'image/jpeg', 'image/jpg'].includes(mimeType)
    || ['png', 'jpg', 'jpeg'].includes(ext);
  const prompt = buildGeminiPrompt(options);
  const content = [];
  if (isDocx) {
    const result = await mammoth.extractRawText({ buffer: fileBuffer });
    const extracted = String(result.value || '').trim();
    if (extracted.length < 20) throw new Error(
      'Could not extract enough text from the DOCX file. The file may be empty or corrupt.');
    content.push({ type: 'text', text: `FILE CONTENT:\n${extracted.slice(0, 30000)}\n\n${prompt}` });
  } else if (isTxt) {
    const extracted = fileBuffer.toString('utf8').trim();
    if (extracted.length < 20) throw new Error('The uploaded text file appears to be empty.');
    content.push({ type: 'text', text: `FILE CONTENT:\n${extracted.slice(0, 30000)}\n\n${prompt}` });
  } else if (isPdf || isImage) {
    let normalizedMime = mimeType;
    if (normalizedMime === 'image/jpg') normalizedMime = 'image/jpeg';
    if (!normalizedMime || normalizedMime === 'application/octet-stream') {
      normalizedMime = isPdf ? 'application/pdf' : ext === 'png' ? 'image/png' : 'image/jpeg';
    }
    content.push({ type: 'image_url', image_url: {
      url: `data:${normalizedMime};base64,${fileBuffer.toString('base64')}`
    } }, { type: 'text', text: prompt });
  } else {
    throw new Error(`Unsupported file type: ${mimeType || ext}. Supported: PDF, DOCX, TXT, PNG, JPG.`);
  }
  const generated = await aiGateway.generate({
    feature: 'worksheet_html_from_file',
    messages: [{ role: 'user', content }],
    maxOutputTokens: Number(process.env.WORKSHEET_AI_MAX_OUTPUT_TOKENS) || 6000,
    responseFormat: 'text',
    validate: (raw) => validateHtml(raw, options.activityTypes)
  });
  return { html: generated.value, title: extractTitle(generated.value),
    provider: generated.provider, model: generated.model };
}

module.exports = { cleanHtmlResponse, extractTitle, containsExecutableHtml, buildGeminiPrompt,
  validateHtml, generateHtmlWorksheetFromFile };
