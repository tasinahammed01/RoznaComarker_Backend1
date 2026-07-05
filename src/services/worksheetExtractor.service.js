/**
 * worksheetExtractor.service.js
 *
 * Extracts and structures worksheet content from uploaded files.
 * Converts raw OCR/text-extracted content into a structured JSON schema
 * with questions, types, answers, and confidence scores.
 */

const { generateChatCompletion } = require('./aiGeneration.service');
const logger = require('../utils/logger');
const jsonrepair = require('jsonrepair');

/**
 * Builds the extraction prompt for LLM structuring.
 * @param {string} extractedText - Raw text from file extraction
 * @param {Object} options - Teacher options (language, subject, etc.)
 * @returns {string} System + user prompt
 */
function buildExtractionPrompt(extractedText, options = {}) {
  const {
    language = 'English',
    subject = 'General',
    gradeLevel = 'Not specified',
  } = options;

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
          "options": ["string", "..."] - only for multiple_choice or matching (array of options),
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

EXTRACTED WORKSHEET CONTENT:
${extractedText}

OUTPUT RULES:
- Return ONLY valid JSON matching this exact schema:
${schema}
- No markdown, no code fences, no explanation
- Start your response with { and end with }
- If you cannot determine a correct answer with high confidence, mark confidence as 'low' and leave correct_answer empty
- For multiple_choice, provide 4 options in the options array
- For matching, provide pairs in the options array
- Be precise with question boundaries - each question should be a single, clear prompt
- CRITICAL for fill_blank questions: Preserve blank markers (underscores like _____ or _______) in the prompt text exactly as they appear in the worksheet. Do NOT remove or replace them. The blank markers indicate where the answer should go. For word banks, return each word as a separate string in the correct_answer array, not concatenated together.`;
}

/**
 * Parses LLM response with JSON repair and validation.
 * @param {string} aiText - Raw LLM response
 * @returns {Object} Parsed and validated structure
 */
function parseExtractionResponse(aiText) {
  logger.info('[EXTRACTION] Parsing LLM response, length:', aiText.length);

  // Extract JSON from response (handles markdown code fences)
  const jsonMatch = aiText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON object found in LLM response');
  }
  const extractedJson = jsonMatch[0];

  // Try direct parse
  let parsed;
  try {
    parsed = JSON.parse(extractedJson);
    logger.info('[EXTRACTION] Direct parse successful');
  } catch (parseError) {
    logger.warn('[EXTRACTION] Direct parse failed, attempting repair:', parseError.message);
    try {
      const repaired = jsonrepair(extractedJson);
      parsed = JSON.parse(repaired);
      logger.info('[EXTRACTION] Parse after repair successful');
    } catch (repairError) {
      logger.error('[EXTRACTION] Repair failed:', repairError.message);
      throw new Error(`JSON parse and repair failed: ${parseError.message}`);
    }
  }

  // Validate required fields
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Parsed result is not a valid object');
  }

  if (!parsed.title || typeof parsed.title !== 'string') {
    throw new Error('Missing or invalid title field');
  }

  if (!Array.isArray(parsed.sections) || parsed.sections.length === 0) {
    throw new Error('No sections array found in response');
  }

  // Validate each section
  for (const section of parsed.sections) {
    if (!section.instruction || typeof section.instruction !== 'string') {
      throw new Error('Section missing instruction field');
    }
    if (!Array.isArray(section.questions) || section.questions.length === 0) {
      throw new Error('Section missing questions array');
    }
    // Validate each question
    for (const q of section.questions) {
      if (!q.id || typeof q.id !== 'string') {
        throw new Error('Question missing id field');
      }
      if (!q.prompt || typeof q.prompt !== 'string') {
        throw new Error('Question missing prompt field');
      }
      if (!q.type || typeof q.type !== 'string') {
        throw new Error('Question missing type field');
      }
      const validTypes = ['fill_blank', 'multiple_choice', 'matching', 'true_false', 'short_answer', 'essay'];
      if (!validTypes.includes(q.type)) {
        throw new Error(`Invalid question type: ${q.type}`);
      }
      if (!q.topic || typeof q.topic !== 'string') {
        throw new Error('Question missing topic field');
      }
      if (!q.confidence || typeof q.confidence !== 'string') {
        throw new Error('Question missing confidence field');
      }
      const validConfidence = ['high', 'medium', 'low'];
      if (!validConfidence.includes(q.confidence)) {
        throw new Error(`Invalid confidence level: ${q.confidence}`);
      }
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

  const prompt = buildExtractionPrompt(extractedText, options);

  try {
    const rawText = await generateChatCompletion(
      [
        {
          role: 'system',
          content: 'You are a worksheet extraction assistant. Return ONLY valid JSON. No markdown, no code fences, no explanation.',
        },
        { role: 'user', content: prompt },
      ],
      {
        temperature: 0.2, // Lower temperature for consistent structuring
        max_tokens: 8000,
        response_format: { type: 'json_object' },
      },
    );

    logger.info('[EXTRACTION] LLM response length:', rawText.length);

    const parsed = parseExtractionResponse(rawText);

    // Debug: Log parsed structure to check word bank format
    logger.info('[EXTRACTION] Parsed structure:', JSON.stringify(parsed, null, 2));

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
    logger.error('[EXTRACTION] Extraction failed:', error.message);
    throw error;
  }
}

module.exports = {
  extractWorksheetStructure,
  convertExtractedToActivities,
  buildExtractionPrompt,
  parseExtractionResponse,
};
