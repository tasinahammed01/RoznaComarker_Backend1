/**
 * worksheetExtractor.service.js
 *
 * Extracts and structures worksheet content from uploaded files.
 * Converts raw OCR/text-extracted content into a structured JSON schema
 * with questions, types, answers, and confidence scores.
 */

const { generateChatCompletion } = require('./aiGeneration.service');
const { getWorksheetExtractionAIConfig } = require('./aiGateway.service');
const logger = require('../utils/logger');

const EXTRACTION_FEATURE = 'worksheet_extract_structure';
const RETRYABLE_OUTPUT_CODES = [
  'AI_OUTPUT_VALIDATION_FAILED',
  'AI_RESPONSE_EMPTY',
  'AI_RESPONSE_INVALID',
  'AI_RESPONSE_TRUNCATED',
];
const DEFAULT_MAX_INPUT_CHARACTERS = 120000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8000;

function extractionValidationError(message, validationCode) {
  const error = new Error(message);
  error.code = validationCode;
  error.validationCode = validationCode;
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
          "options": ["string", "..."] - exactly 4 unique options for multiple_choice; omit otherwise,
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
- If you cannot determine a correct answer with high confidence, mark confidence as 'low' and leave correct_answer empty
- For multiple_choice, provide 4 options in the options array
- Each matching question represents ONE pair: prompt is the left term and correct_answer is its right-side match. Generate several pairs in the same section; do not put pairs in options
- Each fill_blank prompt must contain an underscore blank marker and correct_answer must contain only the missing word or short phrase, never the incomplete prompt
- Treat every MCQ, fill blank, matching pair, and true/false statement as one assessable item
- Adapt counts to the usable source. Do not invent facts to hit a quota, but do not return one token item per type when the source supports more
- Cover distinct concepts across the whole source before reusing a fact. Do not restate the same fact as MCQ, fill blank, and true/false
- MCQ distractors must be plausible and distinct, with exactly one option equal to correct_answer. Vary the correct option position
- Matching sections should normally contain 4-8 unique pairs when supported
- Difficulty rules: easy uses direct source recall; medium emphasizes sequence, comparison, and relationships; hard uses source-grounded inference and cause/effect only
- Be precise with question boundaries - each question should be a single, clear prompt
- CRITICAL for fill_blank questions: create exactly one clear underscore blank per item and preserve it in prompt. Put only that blank's missing word or short phrase in correct_answer. The application builds the shared word bank from these answers.`;
}

/**
 * Parses LLM response with JSON repair and validation.
 * @param {string} aiText - Raw LLM response
 * @returns {Object} Parsed and validated structure
 */
function parseExtractionResponse(aiText) {
  const responseText = typeof aiText === 'string' ? aiText.trim() : '';
  logger.info({ message: 'Worksheet extraction response validation started',
    feature: EXTRACTION_FEATURE, responseTextLength: responseText.length });
  if (!responseText) {
    throw extractionValidationError('Empty LLM response', 'EXTRACTION_RESPONSE_EMPTY');
  }

  // Tolerate only an optional whole-response markdown JSON fence. Do not scan
  // prose for an arbitrary object or repair malformed/truncated JSON.
  const fenceMatch = responseText.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  const extractedJson = (fenceMatch ? fenceMatch[1] : responseText).trim();

  let parsed;
  try {
    parsed = JSON.parse(extractedJson);
  } catch (parseError) {
    throw extractionValidationError('Invalid JSON in LLM response', 'EXTRACTION_INVALID_JSON');
  }

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
        if (!Array.isArray(q.options) || q.options.length !== 4 ||
            new Set(q.options.map(normalizeComparable)).size !== 4) {
          throw extractionValidationError('Multiple choice requires four unique options', 'EXTRACTION_INVALID_MCQ_OPTIONS');
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

  logger.info('[EXTRACTION] Validation successful - sections:', parsed.sections.length);
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
    const parsed = await generateChatCompletion(
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
        validate: (content) => {
          const parsed = parseExtractionResponse(content);
          const counts = parsed.sections.flatMap((section) => section.questions)
            .reduce((acc, question) => ({ ...acc, [question.type]: (acc[question.type] || 0) + 1 }), {});
          const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
          const minimumTotal = richness.sparse ? Math.max(1, richness.targetItems - 3)
            : Math.max(5, Math.floor(richness.targetItems * 0.7));
          if (total < minimumTotal) throw extractionValidationError('Too few assessable items for source richness', 'EXTRACTION_INSUFFICIENT_ITEMS');
          if (!richness.sparse && richness.targetItems >= 10 && (counts.matching || 0) < 4) {
            throw extractionValidationError('Matching activity has too few pairs', 'EXTRACTION_INSUFFICIENT_MATCHING_PAIRS');
          }
          if (!richness.sparse && richness.targetItems >= 10 &&
              ((counts.multiple_choice || 0) < 3 || (counts.fill_blank || 0) < 2 ||
               (counts.true_false || 0) < 2)) {
            throw extractionValidationError('Generated activity distribution is too shallow', 'EXTRACTION_INSUFFICIENT_TYPE_COVERAGE');
          }
          return parsed;
        },
        returnValidated: true,
        retryableSameModelCodes: RETRYABLE_OUTPUT_CODES,
        terminalCodes: ['AI_PROVIDER_AUTH_ERROR', 'AI_PROVIDER_PERMISSION_DENIED',
          'AI_PROVIDER_PAYMENT_REQUIRED', 'AI_PROVIDER_INVALID_REQUEST'],
        onResponse: (result) => { gatewayResult = result; },
      },
    );

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

    logger.info('[EXTRACTION] Extraction complete - activities:', activities.length, 'sections:', parsed.sections.length);

    return {
      title: parsed.title,
      description: parsed.description || '',
      subject: parsed.subject || options.subject || 'General',
      activities,
      answerKey,
      extractedStructure: parsed, // Keep original for review
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
};
