const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const OpenAI = require('openai');
const FlashcardSet = require('../models/FlashcardSet');
const FlashcardSubmission = require('../models/FlashcardSubmission');
const Class = require('../models/class.model');
const Membership = require('../models/membership.model');
const Assignment = require('../models/assignment.model');
const { createNotification } = require('../services/notification.service');
const logger = require('../utils/logger');

const openai = new OpenAI({
  apiKey:  process.env.OPENROUTER_API_KEY,
  baseURL: process.env.OPENROUTER_BASE_URL,
  timeout: parseInt(process.env.OPENROUTER_TIMEOUT_MS) || 60000,
  defaultHeaders: {
    'HTTP-Referer': process.env.FRONTEND_URL || 'http://82.112.234.151:4200',
    'X-Title': 'RoznaComarker Flashcards'
  }
});

function sendSuccess(res, data, statusCode = 200) {
  return res.status(statusCode).json({ success: true, data });
}

function sendError(res, statusCode, message) {
  return res.status(statusCode).json({ success: false, message });
}

function normalizeGeneratedJsonText(value) {
  return String(value || '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .replace(/^\uFEFF/, '')
    .trim();
}

function sanitizeJsonLikeText(value) {
  const source = String(value || '');
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];

    if (inString) {
      if (escaped) {
        result += ch;
        escaped = false;
        continue;
      }

      if (ch === '\\') {
        result += ch;
        escaped = true;
        continue;
      }

      if (ch === '"') {
        result += ch;
        inString = false;
        continue;
      }

      if (ch === '\r') {
        continue;
      }

      if (ch === '\n') {
        result += '\\n';
        continue;
      }

      if (ch === '\t') {
        result += ' ';
        continue;
      }

      result += ch;
      continue;
    }

    if (ch === '"') {
      inString = true;
    }

    result += ch;
  }

  return result;
}

function unwrapGeneratedCards(parsed) {
  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (parsed && Array.isArray(parsed.flashcards)) {
    return parsed.flashcards;
  }

  if (parsed && Array.isArray(parsed.cards)) {
    return parsed.cards;
  }

  return null;
}

function tryParseGeneratedCards(rawText) {
  const sanitized = sanitizeJsonLikeText(rawText).trim();
  if (!sanitized) {
    return null;
  }

  const candidates = [sanitized];

  if (sanitized.startsWith('[') && !sanitized.endsWith(']')) {
    candidates.push(`${sanitized}]`);
  }

  if (sanitized.startsWith('[')) {
    candidates.push(sanitized.replace(/,\s*]$/, ']'));
  }

  const seen = new Set();
  for (const candidate of candidates) {
    const normalizedCandidate = candidate.trim();
    if (!normalizedCandidate || seen.has(normalizedCandidate)) {
      continue;
    }
    seen.add(normalizedCandidate);

    try {
      const parsed = JSON.parse(normalizedCandidate);
      const cards = unwrapGeneratedCards(parsed);
      if (cards) {
        return cards;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function recoverGeneratedCards(rawText) {
  const sanitized = sanitizeJsonLikeText(rawText);
  const firstBracketIndex = sanitized.indexOf('[');
  const source = firstBracketIndex >= 0 ? sanitized.slice(firstBracketIndex + 1) : sanitized;
  const recovered = [];
  let inString = false;
  let escaped = false;
  let depth = 0;
  let start = -1;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (ch === '\\') {
        escaped = true;
        continue;
      }

      if (ch === '"') {
        inString = false;
      }

      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
      continue;
    }

    if (ch === '}' && depth > 0) {
      depth -= 1;

      if (depth === 0 && start >= 0) {
        const snippet = source.slice(start, i + 1);
        try {
          const parsed = JSON.parse(snippet);
          recovered.push(parsed);
        } catch {
          start = -1;
          continue;
        }
        start = -1;
      }
    }
  }

  return recovered;
}

function buildFlashcardPrompt(topic, template, count, language) {
  const base = `Generate ${count} flashcards about "${topic}" in ${language}.
Return ONLY a valid JSON array. No preamble, no markdown, no explanation.
Each item must have exactly: "front" (string) and "back" (string).`;

  const templateInstructions = {
    'term-def': `
Template: TERM AND DEFINITION
- front: A single vocabulary term or key concept (2-5 words max)
- back: A clear, concise definition (1-2 sentences max)
- Example: front="Photosynthesis", back="The process by which plants use sunlight, water, and CO2 to produce glucose and oxygen."
- Do NOT include the term name in the back text.`,

    'qa': `
Template: QUESTION AND ANSWER
- front: A specific, answerable question about the topic
- back: The exact correct answer (concise, 1 sentence)
- Example: front="What gas do plants release during photosynthesis?", back="Oxygen (O2)"
- Questions should have ONE clear correct answer, not open-ended essays.
- Vary question types: what, why, how, which, when.`,

    'concept': `
Template: CONCEPT EXPLANATION
- front: A concept name or "How does X work?" style prompt
- back: A rich explanation with: (1) what it is, (2) how it works, (3) a real-world example. Use 3-5 sentences.
- Example: front="Natural selection", back="Natural selection is the mechanism by which organisms with favorable traits survive and reproduce more. Over time, these traits become more common in the population. For example, darker moths survived better in industrial England because they were harder for birds to spot on soot-covered trees."`
  };

  const instruction = templateInstructions[template] || templateInstructions['term-def'];
  return `${base}\n${instruction}\nReturn format: [{"front":"...","back":"..."},{"front":"...","back":"..."}]`;
}

function normalizeGeneratedCards(cards, requestedCount) {
  const unique = [];
  const seen = new Set();

  for (const card of Array.isArray(cards) ? cards : []) {
    const front = typeof card?.front === 'string' ? card.front.replace(/\s+/g, ' ').trim() : '';
    const back = typeof card?.back === 'string' ? card.back.replace(/\s+/g, ' ').trim() : '';

    if (!front || !back) {
      continue;
    }

    const key = `${front}__${back}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push({ front, back });
  }

  if (Number.isFinite(requestedCount) && requestedCount > 0) {
    return unique.slice(0, requestedCount);
  }

  return unique;
}

async function generateFlashcards(req, res) {
  console.log('[GENERATE] req.body:', req.body);
  console.log('[GENERATE] OPENROUTER_API_KEY exists:', !!process.env.OPENROUTER_API_KEY);
  console.log('[GENERATE] LLAMA_MODEL:', process.env.LLAMA_MODEL);
  console.log('[GENERATE] OPENROUTER_BASE_URL:', process.env.OPENROUTER_BASE_URL);

  try {
    const { content, template, cardCount, language } = req.body;
    const count = cardCount === 'auto' || !cardCount ? 10 : parseInt(cardCount) || 10;
    const resolvedTemplate = ['term-def', 'qa', 'concept'].includes(template) ? template : 'term-def';
    const resolvedLanguage = language || 'English';

    const userPrompt = buildFlashcardPrompt(content, resolvedTemplate, count, resolvedLanguage);

    const completion = await openai.chat.completions.create({
      model: process.env.LLAMA_MODEL || 'meta-llama/llama-3-8b-instruct',
      messages: [
        {
          role: 'system',
          content: `You are a flashcard generation assistant.
You must respond with ONLY a valid JSON array.
Do not write any explanation, introduction, or conclusion.
Do not use markdown or code fences.
Your entire response must start with [ and end with ].
No text before [. No text after ].`
        },
        {
          role: 'user',
          content: userPrompt
        }
      ],
      temperature: 0.5,
      max_tokens: 3000
    });

    let rawText = completion.choices?.[0]?.message?.content;

    if (!rawText) {
      console.error('[GENERATE] Empty response from OpenAI');
      return sendError(res, 500, 'Empty response from AI');
    }

    console.log('[GENERATE] Raw AI response:', rawText.substring(0, 200));

    rawText = normalizeGeneratedJsonText(rawText);

    const firstBracketIndex = rawText.indexOf('[');
    const lastBracketIndex = rawText.lastIndexOf(']');
    if (firstBracketIndex >= 0 && lastBracketIndex > firstBracketIndex) {
      rawText = rawText.slice(firstBracketIndex, lastBracketIndex + 1);
    } else if (firstBracketIndex >= 0) {
      rawText = rawText.slice(firstBracketIndex);
    }

    let cards = tryParseGeneratedCards(rawText);

    if (!cards) {
      console.error('[GENERATE] JSON parse failed: attempting recovery');
      console.error('[GENERATE] Raw text was:', rawText);
      cards = recoverGeneratedCards(rawText);
    }

    cards = normalizeGeneratedCards(cards, count);

    if (cards.length === 0) {
      return sendError(res, 500, 'AI returned no valid cards');
    }

    if (cards.length < count) {
      logger.warn({
        message: 'Recovered partial flashcard generation response',
        requestedCount: count,
        recoveredCount: cards.length
      });
    }

    console.log('[GENERATE] Successfully parsed', cards.length, 'cards');
    return sendSuccess(res, cards);
  } catch (error) {
    console.error('[GENERATE] Full error:', error);
    console.error('[GENERATE] Error message:', error.message);
    console.error('[GENERATE] Error status:', error.status);
    console.error('[GENERATE] Error type:', error.constructor.name);
    if (error.status === 402) {
      console.error('[GENERATE] OpenRouter: insufficient credits');
      return res.status(500).json({ success: false, message: 'AI service credits exhausted. Contact admin.' });
    }
    if (error.status === 429) {
      console.error('[GENERATE] OpenRouter: rate limited');
      return res.status(500).json({ success: false, message: 'AI service rate limited. Try again in a moment.' });
    }
    if (error.status === 401) {
      console.error('[GENERATE] OpenRouter: invalid API key');
      return res.status(500).json({ success: false, message: 'AI service authentication failed.' });
    }
    return sendError(res, 500, error.message || 'Generation failed');
  }
}

async function getAllSets(req, res) {
  try {
    const ownerId = req.user._id;
    const rawSets = await FlashcardSet.find({ ownerId })
      .sort({ updatedAt: -1 })
      .select('title description visibility language updatedAt cards assignedClasses')
      .lean();

    const sets = rawSets.map((set) => {
      const cardCount = Array.isArray(set.cards) ? set.cards.length : 0;
      const { cards, ...rest } = set;
      return { ...rest, cardCount };
    });

    return sendSuccess(res, sets);
  } catch (err) {
    return sendError(res, 500, 'Internal server error');
  }
}


const TEMPLATE_MAP = {
  'term-def':          'term-def',
  'term_def':          'term-def',
  'Term and definition':'term-def',
  'term and definition':'term-def',
  'term-definition':   'term-def',
  'qa':                'qa',
  'question-answer':   'qa',
  'Question and answer':'qa',
  'concept':           'concept',
  'concept-explanation':'concept',
  'Concept explanation':'concept',
};

async function createSet(req, res) {
  console.log('[CREATE FLASHCARD] req.body:', JSON.stringify(req.body, null, 2));

  try {
    const ownerId = req.user._id;
    const { template, cards, title, description, ...rest } = req.body;

    if (!title || !String(title).trim()) {
      return sendError(res, 400, 'Title is required');
    }
    if (!Array.isArray(cards) || cards.length === 0) {
      return sendError(res, 400, 'At least one card is required');
    }

    const resolvedTemplate = TEMPLATE_MAP[template] ?? 'term-def';
    const stampedCards = cards.map(c => ({
      front: typeof c.front === 'string' ? c.front.trim() : c.front,
      back:  typeof c.back  === 'string' ? c.back.trim()  : c.back,
      frontImage: c.frontImage ?? null,
      backImage:  c.backImage  ?? null,
      order:      typeof c.order === 'number' ? c.order : 0,
      template:   resolvedTemplate,
    }));

    const set = await FlashcardSet.create({
      ...rest,
      title: String(title).trim(),
      description: description ? String(description).trim() : '',
      template: resolvedTemplate,
      cards: stampedCards,
      ownerId,
    });
    return sendSuccess(res, set, 201);
  } catch (err) {
    console.error('[CREATE FLASHCARD] Error:', err.message);
    console.error('[CREATE FLASHCARD] Full error:', JSON.stringify(err, null, 2));
    if (err.name === 'ValidationError') {
      console.error('[CREATE FLASHCARD] Validation errors:', err.errors);
      return sendError(res, 400, `Validation failed: ${Object.values(err.errors).map(e => e.message).join(', ')}`);
    }
    if (err.code === 11000) {
      console.error('[CREATE FLASHCARD] Duplicate key error:', err.keyValue);
      return sendError(res, 409, 'Duplicate key conflict');
    }
    return sendError(res, 500, 'Internal server error');
  }
}

async function getSetById(req, res) {
  try {
    const { id } = req.params;
    const role = req.user.role;

    if (role === 'student') {
      const studentId = req.user && req.user._id;
      const set = await FlashcardSet.findById(id).lean();
      if (!set) {
        return sendError(res, 404, 'Flashcard set not found');
      }

      if (set.visibility !== 'private') {
        return sendSuccess(res, set);
      }

      const memberships = await Membership.find({
        student: studentId,
        status: 'active'
      }).select('class').lean();

      const activeClassIds = (memberships || []).map((m) => String(m.class));
      if (activeClassIds.length === 0) {
        return sendError(res, 403, 'Forbidden');
      }

      const assignedClassIds = Array.isArray(set.assignedClasses)
        ? set.assignedClasses.map((clsId) => String(clsId))
        : [];

      const hasAssignedClassAccess = assignedClassIds.some((clsId) => activeClassIds.includes(clsId));

      if (!hasAssignedClassAccess) {
        const assignment = await Assignment.findOne({
          resourceType: 'flashcard',
          resourceId: String(id),
          class: { $in: activeClassIds },
          isActive: true
        }).select('_id').lean();

        if (!assignment) {
          return sendError(res, 403, 'Forbidden');
        }
      }

      return sendSuccess(res, set);
    }

    const set = await FlashcardSet.findOne({ _id: id, ownerId: req.user._id });
    if (!set) {
      return sendError(res, 404, 'Flashcard set not found');
    }
    return sendSuccess(res, set);
  } catch (err) {
    return sendError(res, 500, 'Internal server error');
  }
}

async function updateSet(req, res) {
  try {
    const { id } = req.params;
    const set = await FlashcardSet.findOneAndUpdate(
      { _id: id, ownerId: req.user._id },
      { $set: req.body },
      { new: true, runValidators: true }
    );
    if (!set) {
      return sendError(res, 404, 'Flashcard set not found or not authorised');
    }
    return sendSuccess(res, set);
  } catch (err) {
    return sendError(res, 500, 'Internal server error');
  }
}

async function deleteSet(req, res) {
  try {
    const { id } = req.params;

    const set = await FlashcardSet.findOneAndDelete({ _id: id, ownerId: req.user._id });
    if (!set) {
      return sendError(res, 404, 'Flashcard set not found or not authorised');
    }

    // Cascade: deactivate all assignments referencing this flashcard set, and
    // delete their flashcard submissions.
    try {
      const assignments = await Assignment.find({
        resourceType: 'flashcard',
        resourceId: String(id),
        isActive: true
      }).select('_id').lean();

      const assignmentIds = (assignments || []).map((a) => a._id);

      if (assignmentIds.length) {
        await Assignment.updateMany(
          { _id: { $in: assignmentIds } },
          { $set: { isActive: false } }
        );
        await FlashcardSubmission.deleteMany({ assignmentId: { $in: assignmentIds } });
      }
    } catch (cascadeErr) {
      logger.warn('deleteSet: cascade assignment cleanup failed', cascadeErr);
    }

    await FlashcardSubmission.deleteMany({ flashcardSetId: id });
    return sendSuccess(res, null);
  } catch (err) {
    logger.error('deleteSet failed', err);
    return sendError(res, 500, 'Internal server error');
  }
}

async function submitStudySession(req, res) {
  try {
    const { id } = req.params;
    const userId = req.user._id;

    const existing = await FlashcardSubmission.findOne({ flashcardSetId: id, userId });
    if (existing) {
      return res.status(200).json({
        success: true,
        data: existing,
        message: 'Previous submission returned (first-only policy)'
      });
    }

    const submission = await FlashcardSubmission.create({
      flashcardSetId: id,
      userId,
      results: req.body.results,
      score: req.body.score,
      timeTaken: req.body.timeTaken
    });

    return res.status(201).json({ success: true, data: submission });
  } catch (err) {
    return sendError(res, 500, 'Internal server error');
  }
}

async function assignSet(req, res) {
  try {
    const { id } = req.params;
    const { classId, title, deadline } = req.body;

    if (!classId) {
      return sendError(res, 400, 'classId is required');
    }
    if (!mongoose.Types.ObjectId.isValid(classId)) {
      return sendError(res, 400, 'Invalid classId');
    }

    const teacherId = req.user._id;
    const cls = await Class.findOne({ _id: classId, teacher: teacherId });
    if (!cls) {
      return sendError(res, 403, 'Class not found or does not belong to you');
    }

    const set = await FlashcardSet.findOneAndUpdate(
      { _id: id, ownerId: teacherId },
      { $addToSet: { assignedClasses: classId } },
      { new: true }
    );
    if (!set) {
      return sendError(res, 404, 'Flashcard set not found');
    }

    /** If caller provides title + deadline, also create an Assignment record so
     *  students see a proper assignment entry in their class detail view. */
    let assignment = null;
    if (title && deadline) {
      const parsedDeadline = new Date(deadline);
      if (!isNaN(parsedDeadline.getTime()) && parsedDeadline.getTime() > Date.now()) {
        let qrToken;
        for (let i = 0; i < 5; i++) {
          qrToken = uuidv4();
          try {
            assignment = await Assignment.create({
              title: String(title).trim(),
              writingType: 'flashcard',
              resourceType: 'flashcard',
              resourceId:   String(id),
              deadline:     parsedDeadline,
              class:        classId,
              teacher:      teacherId,
              qrToken
            });
            break;
          } catch (err) {
            if (err && err.code === 11000 && err.keyPattern && err.keyPattern.qrToken) continue;
            throw err;
          }
        }

        /** Fire-and-forget notifications to enrolled students */
        setImmediate(async () => {
          try {
            const memberships = await Membership.find({ class: classId, status: 'active' }).select('student');
            const studentIds  = (memberships || []).map((m) => m && m.student).filter(Boolean);
            const teacherDisplay = String(req.user.displayName || req.user.email || 'Teacher');
            const className = cls.name ? String(cls.name) : 'Class';
            await Promise.all(studentIds.map((sId) =>
              createNotification({
                recipientId: sId,
                actorId:     teacherId,
                type:        'assignment_uploaded',
                title:       'New flashcard set assigned',
                description: `${teacherDisplay} assigned a new flashcard set in ${className}: ${title}`,
                data: {
                  classId:      String(classId),
                  assignmentId: assignment ? String(assignment._id) : null,
                  resourceType: 'flashcard',
                  resourceId:   String(id),
                  route: { path: '/student/my-classes/detail', params: [String(classId)] }
                }
              })
            ));
          } catch (e) {
            logger.warn('assignSet: notification error', e);
          }
        });
      }
    }

    return res.json({ success: true, message: 'Assigned to class', data: { assignment } });
  } catch (err) {
    return sendError(res, 500, 'Internal server error');
  }
}

/**
 * POST /api/flashcards/grade-answer — AI grades a Q&A student answer.
 * Called by the student flashcard player for every Q&A card submission.
 * Uses the same OpenAI client with temperature 0 so grading is deterministic.
 * @body {{ question: string, correctAnswer: string, studentAnswer: string }}
 * @returns {{ isCorrect: boolean }}
 */
async function gradeAnswer(req, res) {
  const { question, correctAnswer, studentAnswer } = req.body;

  if (!question || !correctAnswer) {
    return sendError(res, 400, 'question and correctAnswer are required');
  }

  const trimmedAnswer = String(studentAnswer ?? '').trim();
  if (!trimmedAnswer) {
    return sendSuccess(res, { isCorrect: false });
  }

  const systemPrompt =
`You are a strict but fair grading assistant for a Q&A flashcard system.
Your ONLY job is to decide whether a student's answer is correct or not.
You must respond with ONLY valid JSON — no explanation, no markdown, no extra text.
Valid responses: {"isCorrect":true}  or  {"isCorrect":false}`;

  const userPrompt =
`Question: "${question}"
Correct Answer: "${correctAnswer}"
Student's Answer: "${trimmedAnswer}"

Grading rules (apply ALL of them):
1. Mark CORRECT if the student's answer conveys the same essential meaning as the correct answer, even if worded differently, abbreviated, or paraphrased.
2. Mark CORRECT if the student uses synonyms, minor spelling mistakes, or equivalent phrasing that a teacher would accept.
3. Mark WRONG if the student's answer is nonsensical, gibberish, or random characters (e.g. "fasdfasdca", "aaa", "123abc").
4. Mark WRONG if the answer is a single letter or number with no semantic connection to the question.
5. Mark WRONG if the answer is factually incorrect or directly contradicts the correct answer.
6. Mark WRONG if the answer is completely unrelated to the question topic.
7. Be STRICT: a vague or partial answer that omits the core meaning is WRONG.

Respond with ONLY one of these — nothing else:
{"isCorrect":true}
{"isCorrect":false}`;

  try {
    const completion = await openai.chat.completions.create({
      model:       process.env.LLAMA_MODEL || 'meta-llama/llama-3-8b-instruct',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt  },
      ],
      temperature: 0,
      max_tokens:  20,
    });

    const raw     = (completion.choices?.[0]?.message?.content ?? '').trim();
    const cleaned = raw
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    let isCorrect = false;
    try {
      isCorrect = JSON.parse(cleaned).isCorrect === true;
    } catch {
      isCorrect = /\"isCorrect\"\s*:\s*true/i.test(cleaned);
    }

    console.log(`[GRADE ANSWER] Q: "${String(question).slice(0, 50)}" | student: "${trimmedAnswer.slice(0, 40)}" | result: ${isCorrect}`);
    return sendSuccess(res, { isCorrect });
  } catch (err) {
    console.error('[GRADE ANSWER] Error:', err.message);
    return sendError(res, 500, 'Grading failed');
  }
}

/**
 * POST /api/flashcards/:id/share — teacher generates a public share link.
 * @param {string} req.params.id — flashcard set id
 * @returns {{ shareUrl: string, shareToken: string }}
 */
async function shareFlashcardSet(req, res) {
  try {
    const { id } = req.params;
    const ownerId = req.user._id;

    const set = await FlashcardSet.findOne({ _id: id, ownerId });
    if (!set) return sendError(res, 404, 'Flashcard set not found');

    const shareToken = set.shareToken || uuidv4();
    set.shareToken = shareToken;
    set.isPublic   = true;
    await set.save();

    const frontendUrl = (process.env.FRONTEND_URL || 'http://82.112.234.151:4200').replace(/\/$/, '');
    const shareUrl = `${frontendUrl}/shared/flashcards/${shareToken}`;

    return sendSuccess(res, { shareUrl, shareToken });
  } catch (err) {
    return sendError(res, 500, 'Internal server error');
  }
}

/**
 * DELETE /api/flashcards/:id/share — teacher revokes the public share link.
 * @param {string} req.params.id — flashcard set id
 * @returns {{ message: string }}
 */
async function revokeShare(req, res) {
  try {
    const { id } = req.params;
    const ownerId = req.user._id;

    const set = await FlashcardSet.findOne({ _id: id, ownerId });
    if (!set) return sendError(res, 404, 'Flashcard set not found');

    set.shareToken = null;
    set.isPublic   = false;
    await set.save();

    return sendSuccess(res, { message: 'Share link revoked' });
  } catch (err) {
    return sendError(res, 500, 'Internal server error');
  }
}

module.exports = {
  generateFlashcards,
  getAllSets,
  createSet,
  getSetById,
  updateSet,
  deleteSet,
  submitStudySession,
  assignSet,
  gradeAnswer,
  shareFlashcardSet,
  revokeShare,
};
