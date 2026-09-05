/**
 * worksheetExtractor.service.js
 *
 * Extracts and structures worksheet content from uploaded files.
 * Converts raw OCR/text-extracted content into a structured JSON schema
 * with questions, types, answers, and confidence scores.
 */

const { generateChatCompletion } = require('./aiGeneration.service');
const { getWorksheetExtractionAIConfig } = require('./aiGateway.service');
const { jsonrepair } = require('jsonrepair');
const logger = require('../utils/logger');

const EXTRACTION_FEATURE = 'worksheet_extract_structure';
const DEFAULT_MAX_INPUT_CHARACTERS = 120000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8000;
const EXTRACTED_MCQ_MIN_OPTIONS = 2;
const EXTRACTED_MCQ_MAX_OPTIONS = 8;

function extractionValidationError(message, validationCode) {
  const error = new Error(message);
  error.code = validationCode;
  error.validationCode = validationCode;
  error.diagnostics = [{ code: validationCode, message }];
  return error;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

/**
 * Builds the extraction prompt for LLM structuring.
 * @param {string} extractedText - Raw text from file extraction
 * @param {Object} options - Teacher options (language, subject, etc.)
 * @returns {string} System + user prompt
 */
function normalizeComparable(value) {
  return String(value || '').toLowerCase().replace(/_+/gu, ' blank ')
    .replace(/[^a-z0-9\s]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function stripOptionLabel(value) {
  return String(value ?? '').trim().replace(/^\s*(?:[A-Z]|\d+)\s*[.)\]:-]\s*/iu, '').trim();
}

/** Resolve representational aliases only; never infer an absent answer. */
function resolveCanonicalAnswer(question) {
  if (!question || typeof question !== 'object') return question?.correct_answer;
  const raw = Array.isArray(question.correct_answer)
    ? question.correct_answer.map(value => String(value).trim()).filter(Boolean)
    : String(question.correct_answer ?? '').trim();
  if (question.type === 'true_false') {
    const value = normalizeComparable(Array.isArray(raw) ? raw[0] : raw);
    if (['true', 't', 'yes', '1'].includes(value)) return 'true';
    if (['false', 'f', 'no', '0'].includes(value)) return 'false';
    return raw;
  }
  if (question.type !== 'multiple_choice' || !Array.isArray(question.options)) return raw;
  const answer = Array.isArray(raw) ? raw[0] : raw;
  if (!answer) return '';
  const alias = answer.match(/^\s*([a-z]|\d+)\s*[.)\]:-]?\s*$/iu)?.[1]?.toUpperCase();
  if (alias) {
    const index = /^\d+$/u.test(alias) ? Number(alias) - 1 : alias.charCodeAt(0) - 65;
    if (index >= 0 && index < question.options.length) return question.options[index];
  }
  const comparableAnswer = normalizeComparable(stripOptionLabel(answer));
  const matches = question.options.filter(option => normalizeComparable(stripOptionLabel(option)) === comparableAnswer);
  return matches.length === 1 ? matches[0] : raw;
}

function analyzeSourceRichness(extractedText) {
  const textValue = String(extractedText || '').trim();
  const lines = textValue.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const paragraphs = textValue.split(/(?:\r?\n){2,}/u).map((p) => p.trim()).filter(Boolean);
  const headings = lines.filter((line) => line.length <= 80 &&
    (/[:：]$/u.test(line) || /^[A-Z][A-Z\s\d&/-]{3,}$/u.test(line))).length;
  const listItems = lines.filter((line) => /^(?:[-*•]|\d+[.)])\s+/u.test(line)).length;
  const factCandidates = textValue.split(/(?<=[.!?])\s+|\r?\n/u)
    .map(normalizeComparable).filter((value) => value.split(' ').length >= 4);
  const distinctFacts = new Set(factCandidates).size;
  const namedSequences = lines.filter((line) =>
    /\b(?:stage|step|phase|cycle|category|type|part|first|second|third|then|finally)\b/iu.test(line)).length;
  const factUnits = Math.max(paragraphs.length, distinctFacts, listItems + namedSequences);
  let sizeBand = textValue.length < 2500 ? 'short' : textValue.length <= 8000 ? 'medium' : 'long';
  let targetItems = sizeBand === 'short' ? 7 : sizeBand === 'medium' ? 12 : 17;
  if (sizeBand === 'short' && factUnits >= 10) targetItems = Math.min(15, Math.max(10, Math.round(factUnits * 1.25)));
  if (sizeBand === 'medium') targetItems = Math.min(14, Math.max(10, Math.round(factUnits * 0.75)));
  if (sizeBand === 'long') targetItems = Math.min(20, Math.max(14, Math.round(factUnits * 0.65)));
  const sparse = factUnits < 5;
  if (sparse) targetItems = Math.max(4, Math.min(targetItems, factUnits + 2));
  const matching = targetItems >= 10 ? Math.max(4, Math.round(targetItems * 0.3)) : Math.max(2, Math.round(targetItems * 0.28));
  const multipleChoice = Math.max(2, Math.round(targetItems * 0.27));
  const fillBlank = Math.max(1, Math.round(targetItems * 0.2));
  const trueFalse = Math.max(1, targetItems - matching - multipleChoice - fillBlank);
  return { characterCount: textValue.length, paragraphCount: paragraphs.length, headingCount: headings,
    listItemCount: listItems, distinctFactCount: distinctFacts, namedSequenceCount: namedSequences,
    factUnits, sizeBand, sparse, targetItems,
    distribution: { multiple_choice: multipleChoice, fill_blank: fillBlank, matching, true_false: trueFalse } };
}

function buildExtractionPrompt(extractedText, options = {}) {
  const {
    language = 'English',
    subject = 'General',
    gradeLevel = 'Not specified', difficulty = 'medium',
  } = options;
  const richness = options.richness || analyzeSourceRichness(extractedText);

  const schema = `{
  "title": "string - worksheet title",
  "description": "string - brief description of the worksheet content",
  "subject": "string - subject area (e.g., Math, Science, English)",
  "sections": [
    {
      "instruction": "string - e.g., 'Fill in the blanks with the correct verbs.'",
      "questions": [
        {
          "id": "string - unique identifier (e.g., q1, q2, q3)",
          "prompt": "string - the question or prompt text",
          "type": "fill_blank | multiple_choice | matching | true_false | short_answer | essay",
          "options": ["string", "..."] - the unique answer choices present in the source for multiple_choice; omit otherwise,
          "correct_answer": "string | string[] - the correct answer(s)",
          "topic": "string - skill/topic being tested (e.g., 'present tense verbs', 'multiplication facts')",
          "confidence": "high | medium | low - how confident you are about this extraction"
        }
      ]
    }
  ]
}`;

  return `You are an expert at reading educational worksheets and converting them into structured data.

You will be given raw text extracted from a worksheet (via OCR or text extraction). Your task is to:
1. Identify the worksheet title and subject
2. Identify every section and its instruction
3. Identify every individual question within each section
4. Determine the question type (fill_blank, multiple_choice, matching, true_false, short_answer, essay)
5. Determine the correct answer based on the worksheet's own content (use worked examples to infer patterns)
6. Assign a short topic/skill tag for each question
7. Mark confidence as 'low' if you cannot confidently determine the correct answer or question boundaries

CONTEXT:
- Language: ${language}
- Subject: ${subject || 'General'}
- Grade Level: ${gradeLevel || 'Not specified'}
- Difficulty: ${difficulty || 'medium'}
- Source richness: ${richness.sizeBand}; ${richness.factUnits} distinct factual units estimated
- Target assessable items: approximately ${richness.targetItems}
- Suggested distribution: ${richness.distribution.multiple_choice} multiple choice, ${richness.distribution.fill_blank} fill blanks, ${richness.distribution.matching} matching pairs, ${richness.distribution.true_false} true/false

EXTRACTED WORKSHEET CONTENT:
${extractedText}

OUTPUT RULES:
- Return ONLY valid JSON matching this exact schema:
${schema}
- The top-level "sections" field must always be an array and must not be renamed or wrapped in another object
- No markdown, no code fences, no explanation
- Start your response with { and end with }
- For objective types (multiple_choice, fill_blank, matching, true_false), correct_answer must contain the canonical answer required by the schema
- For subjective types (short_answer, essay), correct_answer means the source's model/reference answer OR its teacher grading guidance; it does not require one literal student response
- Preserve subjective guidance such as "Accept any accurate explanation..." verbatim and mark confidence high when the question boundary, type, and numbered answer-key mapping are clear
- If neither an objective answer nor subjective grading guidance is present reliably in the source, mark confidence low and leave correct_answer empty; never invent a sample answer
- For multiple_choice, preserve exactly the answer choices present in the source. Do not invent, remove, or pad options. A valid extracted multiple-choice question may contain 2 or more source choices
- Each matching question represents ONE pair: prompt is the left term and correct_answer is its right-side match. Generate several pairs in the same section; do not put pairs in options
- Each fill_blank prompt must contain an underscore blank marker and correct_answer must contain only the missing word or short phrase, never the incomplete prompt
- Treat every MCQ, fill blank, matching pair, and true/false statement as one assessable item
- Adapt counts to the usable source. Do not invent facts to hit a quota, but do not return one token item per type when the source supports more
- Cover distinct concepts across the whole source before reusing a fact. Do not restate the same fact as MCQ, fill blank, and true/false
- MCQ distractors must be plausible and distinct, with exactly one option equal to correct_answer. Vary the correct option position
- Matching sections should normally contain 4-8 unique pairs when supported
- Difficulty rules: easy uses direct source recall; medium emphasizes sequence, comparison, and relationships; hard uses source-grounded inference and cause/effect only
- Be precise with question boundaries - each question should be a single, clear prompt
- Preserve the source section order, question meaning, numbering, answer choices, and underscore blanks
- Do not invent questions or answers. Use an answer key only when it is clearly present in the source
- When an answer key exists, connect entries by question ID/number first, then explicit source numbering, and only then normalized question text; never rely only on array position
- Preserve every known source answer. For multiple choice, convert key letters or 1-based option numbers to the exact option value in the options array
- Normalize harmless answer-key whitespace, case, punctuation, and true/false representations without changing meaning
- Treat answer-key table cells as key/value relationships belonging to their labeled question row
- Do not merge unrelated questions or drop valid questions because their formatting is unusual
- Lines beginning with [HEADING], list markers, and TABLE ROW describe source structure, not worksheet content to copy literally
- For table rows, keep each row's cell relationships and treat labeled cells as belonging to that row
- Ignore unsupported visual decoration while retaining all readable question content
- CRITICAL for fill_blank questions: create exactly one clear underscore blank per item and preserve it in prompt. Put only that blank's missing word or short phrase in correct_answer. The application builds the shared word bank from these answers.`;
}

/**
 * Parses LLM response with JSON repair and validation.
 * @param {string} aiText - Raw LLM response
 * @returns {Object} Parsed and validated structure
 */
function extractJsonCandidate(responseText) {
  const fenceMatch = responseText.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  if (fenceMatch) return fenceMatch[1].trim();
  const start = responseText.indexOf('{');
  if (start < 0) return responseText;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < responseText.length; index += 1) {
    const character = responseText[index];
    if (escaped) { escaped = false; continue; }
    if (quoted && character === '\\') { escaped = true; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (character === '{') depth += 1;
    if (character === '}' && --depth === 0) return responseText.slice(start, index + 1);
  }
  return responseText.slice(start);
}

function normalizeExtractionShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const parsed = { ...value };
  ['title', 'description', 'subject'].forEach((key) => {
    if (typeof parsed[key] === 'string') parsed[key] = parsed[key].trim();
  });
  if (!Array.isArray(parsed.sections)) return parsed;
  parsed.sections = parsed.sections.filter((section) => section && typeof section === 'object')
    .map((section) => ({ ...section,
      instruction: typeof section.instruction === 'string' ? section.instruction.trim() : section.instruction,
      questions: Array.isArray(section.questions) ? section.questions.filter(Boolean).map((question) => {
        const q = { ...question };
        if (q.prompt == null && typeof q.question === 'string') q.prompt = q.question;
        if (q.options == null && Array.isArray(q.choices)) q.options = q.choices;
        if (q.correct_answer == null && q.answer != null) q.correct_answer = q.answer;
        const aliases = { mcq: 'multiple_choice', 'multiple-choice': 'multiple_choice',
          fill_in_blank: 'fill_blank', 'fill-in-the-blank': 'fill_blank',
          open_ended: 'short_answer', 'open-ended': 'short_answer', truefalse: 'true_false' };
        q.type = aliases[String(q.type || '').toLowerCase()] || String(q.type || '').toLowerCase();
        ['id', 'prompt', 'topic', 'confidence', 'correct_answer'].forEach((key) => {
          if (typeof q[key] === 'string') q[key] = q[key].trim();
        });
        if (Array.isArray(q.options)) q.options = q.options.map((option) => String(option).trim()).filter(Boolean);
        q.correct_answer = resolveCanonicalAnswer(q);
        if (typeof q.confidence === 'string') q.confidence = q.confidence.toLowerCase();
        return q;
      }) : section.questions,
    })).filter((section) => !Array.isArray(section.questions) || section.questions.length > 0);
  return parsed;
}

function parseExtractionResponse(aiText) {
  const responseText = typeof aiText === 'string' ? aiText.trim() : '';
  logger.info({ message: 'Worksheet extraction response validation started',
    event: 'worksheet_validation', stage: 'parse_normalize', status: 'started',
    feature: EXTRACTION_FEATURE, responseTextLength: responseText.length });
  if (!responseText) {
    throw extractionValidationError('Empty LLM response', 'EXTRACTION_RESPONSE_EMPTY');
  }

  const extractedJson = extractJsonCandidate(responseText).trim();

  let parsed;
  try {
    parsed = JSON.parse(extractedJson);
  } catch (parseError) {
    try { parsed = JSON.parse(jsonrepair(extractedJson)); }
    catch { throw extractionValidationError('Invalid JSON in LLM response', 'EXTRACTION_INVALID_JSON'); }
  }
  parsed = normalizeExtractionShape(parsed);
  logger.info({ message: 'Worksheet extraction response parsed and normalized', event: 'worksheet_validation',
    stage: 'parse_normalize', status: 'passed', feature: EXTRACTION_FEATURE });

  // Validate required fields
  if (!parsed || typeof parsed !== 'object') {
    throw extractionValidationError('Parsed result is not a valid object', 'EXTRACTION_INVALID_ROOT');
  }

  if (!parsed.title || typeof parsed.title !== 'string') {
    throw extractionValidationError('Missing or invalid title field', 'EXTRACTION_INVALID_TITLE');
  }

  if (!Array.isArray(parsed.sections) || parsed.sections.length === 0) {
    throw extractionValidationError('No sections array found in response', 'EXTRACTION_MISSING_SECTIONS');
  }

  // Validate each section
  const ids = new Set();
  const comparablePrompts = [];
  for (const section of parsed.sections) {
    if (!section.instruction || typeof section.instruction !== 'string') {
      throw extractionValidationError('Section missing instruction field', 'EXTRACTION_INVALID_SECTION_INSTRUCTION');
    }
    if (!Array.isArray(section.questions) || section.questions.length === 0) {
      throw extractionValidationError('Section missing questions array', 'EXTRACTION_MISSING_QUESTIONS');
    }
    // Validate each question
    for (const q of section.questions) {
      if (!q.id || typeof q.id !== 'string') {
        throw extractionValidationError('Question missing id field', 'EXTRACTION_INVALID_QUESTION_ID');
      }
      if (ids.has(q.id)) throw extractionValidationError('Duplicate question id', 'EXTRACTION_DUPLICATE_QUESTION_ID');
      ids.add(q.id);
      if (!q.prompt || typeof q.prompt !== 'string') {
        throw extractionValidationError('Question missing prompt field', 'EXTRACTION_INVALID_QUESTION_PROMPT');
      }
      if (!q.type || typeof q.type !== 'string') {
        throw extractionValidationError('Question missing type field', 'EXTRACTION_INVALID_QUESTION_TYPE');
      }
      const validTypes = ['fill_blank', 'multiple_choice', 'matching', 'true_false', 'short_answer', 'essay'];
      if (!validTypes.includes(q.type)) {
        throw extractionValidationError(`Invalid question type: ${q.type}`, 'EXTRACTION_INVALID_QUESTION_TYPE');
      }
      if (q.type === 'multiple_choice') {
        const optionCount = Array.isArray(q.options) ? q.options.length : 0;
        const normalizedOptions = Array.isArray(q.options) ? q.options.map(normalizeComparable) : [];
        let optionReason = null;
        if (!Array.isArray(q.options)) optionReason = 'options_not_array';
        else if (optionCount < EXTRACTED_MCQ_MIN_OPTIONS) optionReason = 'too_few_options';
        else if (optionCount > EXTRACTED_MCQ_MAX_OPTIONS) optionReason = 'too_many_options';
        else if (normalizedOptions.some(option => !option)) optionReason = 'empty_option';
        else if (new Set(normalizedOptions).size !== optionCount) optionReason = 'duplicate_options';
        if (optionReason) {
          const error = extractionValidationError(
            `Multiple-choice question ${q.id} must contain ${EXTRACTED_MCQ_MIN_OPTIONS}-${EXTRACTED_MCQ_MAX_OPTIONS} unique, non-empty source options.`,
            'EXTRACTION_INVALID_MCQ_OPTIONS');
          error.diagnostics = [{ code: error.code, questionId: q.id, optionCount, reason: optionReason,
            message: error.message }];
          throw error;
        }
        if (typeof q.correct_answer !== 'string' || !q.options.includes(q.correct_answer)) {
          throw extractionValidationError('Multiple choice answer must match one option', 'EXTRACTION_INVALID_MCQ_ANSWER');
        }
      }
      if (q.type === 'fill_blank') {
        const answer = typeof q.correct_answer === 'string' ? q.correct_answer.trim() : '';
        if (!/_+/u.test(q.prompt) || !answer || answer.length > 80 || normalizeComparable(answer) === normalizeComparable(q.prompt)) {
          throw extractionValidationError('Malformed fill blank question', 'EXTRACTION_INVALID_FILL_BLANK');
        }
      }
      if (q.type === 'matching') {
        if (typeof q.correct_answer !== 'string' || !q.correct_answer.trim() ||
            normalizeComparable(q.prompt) === normalizeComparable(q.correct_answer)) {
          throw extractionValidationError('Malformed matching pair', 'EXTRACTION_INVALID_MATCHING_PAIR');
        }
      }
      if (q.type === 'true_false' && !['true', 'false'].includes(String(q.correct_answer).toLowerCase())) {
        throw extractionValidationError('True/false answer must be boolean-like', 'EXTRACTION_INVALID_TRUE_FALSE_ANSWER');
      }
      if (!q.topic || typeof q.topic !== 'string') {
        throw extractionValidationError('Question missing topic field', 'EXTRACTION_INVALID_TOPIC');
      }
      if (!q.confidence || typeof q.confidence !== 'string') {
        throw extractionValidationError('Question missing confidence field', 'EXTRACTION_INVALID_CONFIDENCE');
      }
      const validConfidence = ['high', 'medium', 'low'];
      if (!validConfidence.includes(q.confidence)) {
        throw extractionValidationError(`Invalid confidence level: ${q.confidence}`, 'EXTRACTION_INVALID_CONFIDENCE');
      }
      const normalizedPrompt = normalizeComparable(q.prompt);
      if (comparablePrompts.some((prior) => prior === normalizedPrompt ||
          (prior.length > 24 && normalizedPrompt.length > 24 &&
           prior.split(' ').filter((word) => normalizedPrompt.split(' ').includes(word)).length /
             Math.max(prior.split(' ').length, normalizedPrompt.split(' ').length) >= 0.85))) {
        throw extractionValidationError('Duplicate or near-duplicate question', 'EXTRACTION_DUPLICATE_QUESTION');
      }
      comparablePrompts.push(normalizedPrompt);
    }
  }

  return parsed;
}

/**
 * Converts extracted structure to native activities array format.
 * Maps extracted question types to activity types used by the worksheet viewer.
 * @param {Object} extractedStructure - Parsed extraction result
 * @returns {Array} Activities array compatible with Worksheet model
 */
function convertExtractedToActivities(extractedStructure) {
  const activities = [];
  let activityOrder = 0;

  const typeMapping = {
    'fill_blank': 'fillBlanks',
    'multiple_choice': 'multipleChoice',
    'matching': 'matching',
    'true_false': 'trueFalse',
    'short_answer': 'shortAnswer',
    'essay': 'shortAnswer', // Essays treated as short answer for now
  };

  for (const section of extractedStructure.sections) {
    // Group questions by type within each section
    const questionsByType = {};
    for (const q of section.questions) {
      const activityType = typeMapping[q.type] || 'shortAnswer';
      if (!questionsByType[activityType]) {
        questionsByType[activityType] = [];
      }
      questionsByType[activityType].push(q);
    }

    // Create an activity for each question type in this section
    for (const [activityType, questions] of Object.entries(questionsByType)) {
      const activity = {
        type: activityType,
        title: `${section.instruction.slice(0, 50)}${section.instruction.length > 50 ? '...' : ''}`,
        instructions: section.instruction,
        data: {},
        order: activityOrder++,
      };

      // Build activity-specific data structure
      switch (activityType) {
        case 'fillBlanks':
          // Build word bank from all correct answers, split concatenated strings into individual words
          const allAnswers = questions
            .filter(q => q.correct_answer)
            .map(q => Array.isArray(q.correct_answer) ? q.correct_answer[0] : String(q.correct_answer));
          // Split concatenated answers (e.g., "winkeddancedwhispered") into individual words
          // Try to split by camelCase or just treat as single words
          const splitAnswers = allAnswers.flatMap(answer => {
            // Try camelCase split first
            const camelCaseSplit = answer.split(/(?=[A-Z])/).filter(w => w.length > 0);
            if (camelCaseSplit.length > 1) return camelCaseSplit;
            // If no camelCase, treat as single word
            return [answer];
          });
          const wordBank = [...new Set(splitAnswers)].slice(0, 10);

          activity.data = {
            wordBank,
            sentences: questions.map((q, idx) => {
              const prompt = q.prompt || '';

              // Parse the prompt to find blank positions (underscores or other markers)
              // Create parts array with text and blank parts interleaved
              const parts = [];
              let currentPos = 0;

              // Find all blank markers (underscores of any length)
              const blankRegex = /_+/g;
              let match;
              let blankIndex = 0;

              while ((match = blankRegex.exec(prompt)) !== null) {
                // Add text before the blank
                const textBefore = prompt.substring(currentPos, match.index);
                if (textBefore) {
                  parts.push({ type: 'text', value: textBefore });
                }

                // Add blank part
                // If the AI provided multiple correct answers, use them; otherwise use a single answer
                let blankAnswer;
                if (Array.isArray(q.correct_answer) && q.correct_answer.length > blankIndex) {
                  blankAnswer = q.correct_answer[blankIndex];
                } else if (typeof q.correct_answer === 'string') {
                  // Try to split concatenated answer for multiple blanks
                  const camelCaseSplit = q.correct_answer.split(/(?=[A-Z])/).filter(w => w.length > 0);
                  if (camelCaseSplit.length > blankIndex) {
                    blankAnswer = camelCaseSplit[blankIndex];
                  } else {
                    blankAnswer = q.correct_answer;
                  }
                } else {
                  blankAnswer = '';
                }

                parts.push({
                  type: 'blank',
                  blankId: `${q.id}_b${blankIndex}`,
                  correctAnswer: blankAnswer
                });

                currentPos = match.index + match[0].length;
                blankIndex++;
              }

              // Add remaining text after last blank
              const textAfter = prompt.substring(currentPos);
              if (textAfter) {
                parts.push({ type: 'text', value: textAfter });
              }

              // If no blanks found, treat entire prompt as text with one blank at end (fallback)
              if (parts.length === 0 || parts.every(p => p.type === 'text')) {
                parts.push({ type: 'text', value: prompt });
                parts.push({
                  type: 'blank',
                  blankId: q.id,
                  correctAnswer: Array.isArray(q.correct_answer) ? q.correct_answer[0] : q.correct_answer
                });
              }

              // Clean up text parts (remove extra spaces from blank removal)
              parts.forEach(part => {
                if (part.type === 'text' && part.value) {
                  part.value = part.value.replace(/\s+/g, ' ').trim();
                }
              });

              return {
                id: q.id,
                parts,
              };
            }),
          };
          break;

        case 'multipleChoice':
          activity.data = {
            questions: questions.map(q => ({
              id: q.id,
              text: q.prompt,
              options: Array.isArray(q.options) ? q.options : [],
              correctAnswer: Array.isArray(q.correct_answer) ? q.correct_answer[0] : q.correct_answer,
            })),
          };
          break;

        case 'matching':
          activity.data = {
            pairs: questions.map((q, idx) => ({
              id: q.id,
              pairId: q.id,
              leftItem: { text: q.prompt },
              rightItem: { text: Array.isArray(q.correct_answer) ? q.correct_answer[0] : q.correct_answer },
            })),
          };
          break;

        case 'trueFalse':
          activity.data = {
            questions: questions.map(q => ({
              id: q.id,
              text: q.prompt,
              correctAnswer: String(q.correct_answer).toLowerCase() === 'true',
              explanation: '',
            })),
          };
          break;

        case 'shortAnswer':
          activity.data = {
            questions: questions.map(q => ({
              id: q.id,
              text: q.prompt,
              modelAnswer: Array.isArray(q.correct_answer) ? q.correct_answer[0] : q.correct_answer,
              maxWords: 50,
            })),
          };
          break;

        default:
          // Fallback for unknown types
          activity.data = {
            questions: questions.map(q => ({
              id: q.id,
              text: q.prompt,
              modelAnswer: Array.isArray(q.correct_answer) ? q.correct_answer[0] : q.correct_answer,
            })),
          };
      }

      activities.push(activity);
    }
  }

  logger.info('[EXTRACTION] Converted to activities:', activities.length);
  return activities;
}

function validateExtractionForSource(parsed, richness) {
  const counts = parsed.sections.flatMap((section) => section.questions)
    .reduce((acc, question) => ({ ...acc, [question.type]: (acc[question.type] || 0) + 1 }), {});
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const minimumTotal = richness.sparse ? Math.max(1, richness.targetItems - 3)
    : Math.max(5, Math.floor(richness.targetItems * 0.7));
  if (total < minimumTotal) throw extractionValidationError('Too few assessable items for source richness', 'EXTRACTION_INSUFFICIENT_ITEMS');
  return parsed;
}

function validationStageForCode(code) {
  if (['EXTRACTION_RESPONSE_EMPTY', 'EXTRACTION_INVALID_JSON', 'EXTRACTION_INVALID_ROOT'].includes(code)) {
    return 'parse_normalize';
  }
  if (['EXTRACTION_INVALID_TITLE', 'EXTRACTION_MISSING_SECTIONS',
    'EXTRACTION_INVALID_SECTION_INSTRUCTION', 'EXTRACTION_MISSING_QUESTIONS',
    'EXTRACTION_INVALID_QUESTION_ID', 'EXTRACTION_INVALID_QUESTION_PROMPT',
    'EXTRACTION_INVALID_QUESTION_TYPE'].includes(code)) return 'schema';
  return code === 'EXTRACTION_INSUFFICIENT_ITEMS' ? 'source_coverage' : 'semantic';
}

function validateExtractionPipeline(aiText, richness, context = {}) {
  let parsed;
  try {
    parsed = parseExtractionResponse(aiText);
  } catch (error) {
    const stage = validationStageForCode(error.code);
    logger.warn({ message: 'Worksheet validation failed', event: 'worksheet_validation', stage,
      status: 'failed', code: error.code, feature: EXTRACTION_FEATURE,
      requestId: context.requestId || null });
    return { ok: false, stage, code: error.code, errors: error.diagnostics || [], error };
  }
  logger.info({ message: 'Worksheet schema validation passed', event: 'worksheet_validation',
    stage: 'schema', status: 'passed', feature: EXTRACTION_FEATURE, requestId: context.requestId || null });
  logger.info({ message: 'Worksheet semantic validation passed', event: 'worksheet_validation',
    stage: 'semantic', status: 'passed', feature: EXTRACTION_FEATURE, requestId: context.requestId || null });
  try {
    validateExtractionForSource(parsed, richness);
  } catch (error) {
    logger.warn({ message: 'Worksheet source coverage validation failed', event: 'worksheet_validation',
      stage: 'source_coverage', status: 'failed', code: error.code, feature: EXTRACTION_FEATURE,
      requestId: context.requestId || null });
    return { ok: false, stage: 'source_coverage', code: error.code,
      errors: error.diagnostics || [], error };
  }
  logger.info({ message: 'Worksheet source coverage validation passed', event: 'worksheet_validation',
    stage: 'source_coverage', status: 'passed', feature: EXTRACTION_FEATURE,
    requestId: context.requestId || null });
  return { ok: true, value: parsed, errors: [], finalFailureCode: null };
}

function buildRepairPrompt(aiOutput, validationError) {
  const diagnostics = Array.isArray(validationError?.diagnostics) ? validationError.diagnostics
    : [{ code: validationError?.code || 'EXTRACTION_SCHEMA_INVALID', message: validationError?.message || 'Invalid schema' }];
  const sourceAwareMcqInstruction = diagnostics.some(item => item.code === 'EXTRACTION_INVALID_MCQ_OPTIONS')
    ? '\nFor multiple-choice corrections, preserve the exact source options. Ensure they are unique and non-empty and that the correct answer matches exactly one option. Never pad a source question to four options or fabricate a distractor.\n'
    : '';
  return `Correct the worksheet JSON below so it matches the schema and semantic rules from the prior request.${sourceAwareMcqInstruction}
Return JSON only. Preserve the same worksheet content and order. Do not add or remove worksheet content unless required by validation.

VALIDATOR ERRORS:
${JSON.stringify(diagnostics.slice(0, 20))}

ORIGINAL AI OUTPUT:
${String(aiOutput || '').slice(0, 40000)}`;
}

/**
 * Main extraction function.
 * @param {string} extractedText - Raw text from file extraction
 * @param {Object} options - Teacher options
 * @returns {Promise<Object>} Extracted structure with activities
 */
async function extractWorksheetStructure(extractedText, options = {}) {
  logger.info('[EXTRACTION] Starting worksheet structure extraction');
  logger.info('[EXTRACTION] Extracted text length:', extractedText.length);

  const maxInputCharacters = boundedInteger(process.env.WORKSHEET_EXTRACTION_AI_MAX_INPUT_CHARACTERS,
    DEFAULT_MAX_INPUT_CHARACTERS, 1000, 500000);
  if (extractedText.length > maxInputCharacters) {
    const error = new Error('Worksheet text exceeds the safe AI input limit.');
    error.code = 'WORKSHEET_EXTRACTION_INPUT_TOO_LARGE';
    error.userMessage = 'This worksheet is too large to extract at once. Please upload a shorter document.';
    throw error;
  }
  const richness = analyzeSourceRichness(extractedText);
  const prompt = buildExtractionPrompt(extractedText, { ...options, richness });
  const maxOutputTokens = boundedInteger(process.env.WORKSHEET_EXTRACTION_AI_MAX_OUTPUT_TOKENS,
    DEFAULT_MAX_OUTPUT_TOKENS, 1000, 16000);
  logger.info({ message: 'Worksheet extraction prompt prepared', feature: EXTRACTION_FEATURE,
    extractedCharacterCount: extractedText.length, promptCharacterCount: prompt.length,
    estimatedPromptTokens: Math.ceil(prompt.length / 4), maxOutputTokens });

  try {
    let gatewayResult = null;
    const config = getWorksheetExtractionAIConfig(process.env);
    const firstOutput = await generateChatCompletion(
      [
        {
          role: 'system',
          content: 'You are a worksheet extraction assistant. Return ONLY valid JSON. No markdown, no code fences, no explanation.',
        },
        { role: 'user', content: prompt },
      ],
      {
        temperature: 0.2, // Lower temperature for consistent structuring
        max_tokens: maxOutputTokens,
        response_format: { type: 'json_object' },
        feature: EXTRACTION_FEATURE,
        env: process.env,
        config,
        metadata: { requestId: options.requestId, purpose: 'initial_structure' },
        terminalCodes: ['AI_PROVIDER_AUTH_ERROR', 'AI_PROVIDER_PERMISSION_DENIED',
          'AI_PROVIDER_PAYMENT_REQUIRED', 'AI_PROVIDER_INVALID_REQUEST'],
        onResponse: (result) => { gatewayResult = result; },
      },
    );

    let repairAttempted = false;
    const validationHistory = [];
    let validation = validateExtractionPipeline(firstOutput, richness, options);
    let parsed;
    if (!validation.ok) {
      const initialValidationError = validation.error;
      validationHistory.push({ stage: validation.stage, code: validation.code });
      repairAttempted = true;
      logger.warn({ message: 'Worksheet extraction output requires bounded repair',
        event: 'worksheet_ai_repair_started', feature: EXTRACTION_FEATURE,
        requestId: options.requestId || null, validationCode: initialValidationError.code,
        validationErrorsCount: initialValidationError.diagnostics?.length || 1 });
      let repairOutput;
      try {
        repairOutput = await generateChatCompletion([
          { role: 'system', content: 'You repair worksheet JSON. Return only the corrected JSON object.' },
          { role: 'user', content: buildRepairPrompt(firstOutput, initialValidationError) },
        ], {
          temperature: 0, max_tokens: maxOutputTokens, response_format: { type: 'json_object' },
          feature: `${EXTRACTION_FEATURE}_repair`, env: process.env, config,
          metadata: { requestId: options.requestId, purpose: 'schema_repair' },
          terminalCodes: ['AI_PROVIDER_AUTH_ERROR', 'AI_PROVIDER_PERMISSION_DENIED',
            'AI_PROVIDER_PAYMENT_REQUIRED', 'AI_PROVIDER_INVALID_REQUEST'],
        });
        validation = validateExtractionPipeline(repairOutput, richness, options);
        if (!validation.ok) throw validation.error;
        parsed = validation.value;
        logger.info({ message: 'Worksheet repair accepted', event: 'worksheet_repair', status: 'success',
          feature: EXTRACTION_FEATURE, requestId: options.requestId || null });
      } catch (repairError) {
        if (repairError?.code?.startsWith('AI_') && !repairError?.code?.startsWith('AI_OUTPUT')) throw repairError;
        const finalCode = repairError?.code || 'AI_OUTPUT_VALIDATION_FAILED';
        const error = extractionValidationError('AI worksheet output remained invalid after one repair pass', finalCode);
        error.finalFailureCode = finalCode;
        error.repairAttempted = true;
        error.diagnostics = repairError?.diagnostics || [{ code: repairError?.code || 'EXTRACTION_REPAIR_INVALID',
          message: repairError?.message || 'Repair output invalid' }];
        throw error;
      }
    } else {
      parsed = validation.value;
    }

    logger.info({ message: 'Worksheet extraction AI output accepted', feature: EXTRACTION_FEATURE,
      attemptCount: gatewayResult?.attempts?.length || 1, provider: gatewayResult?.provider || null,
      model: gatewayResult?.model || null,
      responseTextLength: gatewayResult?.attempts?.at(-1)?.responseTextLength || null,
      finishReason: gatewayResult?.attempts?.at(-1)?.finishReason || null,
      durationMs: gatewayResult?.attempts?.reduce((sum, attempt) => sum + (attempt.durationMs || 0), 0) || null });

    // Convert to activities format
    const activities = convertExtractedToActivities(parsed);

    // Build answer key for auto-grading
    const answerKey = {
      title: parsed.title,
      sections: parsed.sections.map(section => ({
        instruction: section.instruction,
        questions: section.questions.map(q => ({
          id: q.id,
          type: q.type,
          correctAnswer: q.correct_answer,
          topic: q.topic,
          confidence: q.confidence,
        })),
      })),
    };

    const questionCount = parsed.sections.reduce((sum, section) => sum + section.questions.length, 0);
    logger.info({ message: 'Worksheet extraction complete', event: 'worksheet_extract_completed',
      feature: EXTRACTION_FEATURE, requestId: options.requestId || null, sections: parsed.sections.length,
      questions: questionCount, repairUsed: repairAttempted });

    return {
      title: parsed.title,
      description: parsed.description || '',
      subject: parsed.subject || options.subject || 'General',
      activities,
      answerKey,
      extractedStructure: parsed, // Keep original for review
      extractionDiagnostics: { repairAttempted, validationErrors: [], validationHistory,
        finalFailureCode: null },
    };
  } catch (error) {
    logger.error({ message: 'Worksheet extraction failed', feature: EXTRACTION_FEATURE,
      code: error.code || 'AI_OUTPUT_VALIDATION_FAILED',
      finalFailureCode: error.finalFailureCode || error.code || 'AI_OUTPUT_VALIDATION_FAILED',
      attemptCount: error.attemptCount || error.attempts?.length || 0,
      timeoutCount: error.timeoutCount || 0,
      attempts: Array.isArray(error.attempts) ? error.attempts.map((attempt) => ({
        provider: attempt.provider, model: attempt.model, code: attempt.code,
        httpStatus: attempt.httpStatus, finishReason: attempt.finishReason,
        validationCode: attempt.validationCode, responseTextLength: attempt.responseTextLength,
        promptTokenCount: attempt.promptTokenCount, candidateTokenCount: attempt.candidateTokenCount,
        totalTokenCount: attempt.totalTokenCount, retryIndex: attempt.retryIndex,
        fallbackIndex: attempt.fallbackIndex
      })) : [] });
    throw error;
  }
}

module.exports = {
  extractWorksheetStructure,
  convertExtractedToActivities,
  buildExtractionPrompt,
  parseExtractionResponse,
  analyzeSourceRichness,
  normalizeExtractionShape,
  validateExtractionForSource,
  validateExtractionPipeline,
  buildRepairPrompt,
  resolveCanonicalAnswer,
  EXTRACTED_MCQ_MIN_OPTIONS,
  EXTRACTED_MCQ_MAX_OPTIONS,
};
