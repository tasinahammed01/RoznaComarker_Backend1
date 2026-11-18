'use strict';
// Helpers for the speaking-assessment suites: a fake OpenRouter reply (the REAL gateway runs against it; no network), a valid model output
// for the default speaking rubric, credit wallets, and a ready recording with its assessed text and fluency figures. Synthetic data only;
// the API key below is a placeholder, never a real credential.
const mongoose = require('mongoose');
const AudioRecording = require('../../src/models/AudioRecording');
const CreditWallet = require('../../src/models/CreditWallet');
const Institution = require('../../src/models/Institution');
const InstitutionMember = require('../../src/models/InstitutionMember');
const InstitutionCreditWallet = require('../../src/models/InstitutionCreditWallet');
const Class = require('../../src/models/class.model');
const { getOrCreateWallet } = require('../../src/services/credit.service');
const { makeAudioSubmission } = require('./speakingFixtures');

const MODEL = 'google/gemini-3.8-flash';
/** The gateway environment for tests: the approved assessment model and a placeholder key (requests go to the injected fake, never out). */
const TEST_ENV = Object.freeze({ ...process.env, NODE_ENV: 'test', OPENROUTER_API_KEY: 'test-placeholder-not-a-key', ASSESSMENT_AI_MODEL: MODEL,
  OPENROUTER_BASE_URL: '', ASSESSMENT_AI_PRIMARY_RETRIES: '0', AI_PRIMARY_RETRIES: '0', AI_RETRY_DELAY_MS: '0' });

const DEFAULT_IDS = ['speaking-task', 'speaking-organisation', 'speaking-grammar', 'speaking-vocabulary', 'speaking-fluency'];
const COMMENT = 'The answer explains the main ideas clearly and gives an example to support them.';

/** A valid model output for the default rubric. levels: { criterionId: levelTitle }. */
function output({ levels = {}, level = 'Good', corrections = [], relevance = 'on_topic', assessable = true, reason = 'none', comment = COMMENT,
  strengths = ['You stayed on the topic and described your town with clear examples.'],
  improvements = ['Try linking your ideas with words such as however and because.'],
  summary = 'A clear answer about your town with good examples; work on linking ideas and on a few verb forms.', extra = {} } = {}) {
  if (!assessable) return { assessable: false, notAssessableReason: reason, relevance, criteria: [], corrections: [], strengths: [], improvements: [], summary: 'Not assessable.', ...extra };
  return { assessable: true, notAssessableReason: 'none', relevance, criteria: DEFAULT_IDS.map(criterionId => ({ criterionId, level: levels[criterionId] || level, comment })),
    corrections, strengths, improvements, summary, ...extra };
}

/** A fake OpenRouter: each call returns the next reply (an object is the model's JSON; { status } an HTTP error; a string raw content). */
function fakeOpenRouter(replies, { usage = { prompt_tokens: 2400, completion_tokens: 900, cost: 0.0026 }, model = MODEL } = {}) {
  const queue = Array.isArray(replies) ? [...replies] : [replies];
  const fetchImpl = jest.fn(async (_url, init) => {
    const reply = queue.length > 1 ? queue.shift() : queue[0];
    if (reply && typeof reply === 'object' && Number.isInteger(reply.status)) {
      return { ok: false, status: reply.status, headers: { get: () => null }, text: async () => JSON.stringify({ error: { code: reply.status, message: 'synthetic' } }) };
    }
    const content = typeof reply === 'string' ? reply : JSON.stringify(reply);
    fetchImpl.bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, headers: { get: () => null },
      text: async () => JSON.stringify({ model, choices: [{ message: { content }, finish_reason: 'stop' }], usage }) };
  });
  fetchImpl.bodies = [];
  return fetchImpl;
}

/** Personal wallet with exactly `credits` usable credits. */
async function personalCredits(teacher, credits) {
  // The plan's monthly allowance is re-applied by getOrCreateWallet, so it is marked fully used and the credits are purchased ones.
  const { wallet } = await getOrCreateWallet(teacher);
  await CreditWallet.updateOne({ _id: wallet._id }, { $set: { monthlyCreditsUsed: wallet.monthlyCredits, purchasedCredits: credits, bonusCredits: 0 } });
}

/** Puts the class in an institution whose wallet holds `credits`; the teacher is an active member. Returns the institution. */
async function institutionCredits(f, credits) {
  const institution = await Institution.create({ name: 'Synthetic School', ownerUserId: f.teacher.user._id, status: 'ACTIVE' });
  await InstitutionMember.create({ institutionId: institution._id, userId: f.teacher.user._id, role: 'TEACHER', status: 'ACTIVE' });
  const now = Date.now();
  await InstitutionCreditWallet.create({ institutionId: institution._id, monthlyCredits: credits, monthlyCreditsUsed: 0, topUpCredits: 0,
    cycleStart: new Date(now - 86400000), cycleEnd: new Date(now + 20 * 86400000) });
  await Class.updateOne({ _id: f.klass._id }, { $set: { institutionId: institution._id } });
  return institution;
}

/** A synthetic word list: words, one filler after every 12th word, 0.35 s per word, a 1.4 s pause every 40 words. */
function fluencyFor(text, { fillersPer100 = null, wordsPerMinute = null } = {}) {
  const words = String(text).split(/\s+/).filter(Boolean).length;
  const fillers = fillersPer100 == null ? Math.floor(words / 12) : Math.round(words * fillersPer100 / 100);
  const total = words + fillers;
  // wordsPerMinute: the speech lasts exactly as long as that pace needs (pauses included); otherwise about 0.35 s per word plus the pauses.
  const seconds = wordsPerMinute ? Math.round(words / wordsPerMinute * 60 * 100) / 100 : Math.round((total * 0.35 + Math.floor(words / 40) * 1.4) * 100) / 100;
  return { metricsVersion: 'audio-fluency-v1', available: true, totalWords: total, spokenWords: words, fillerCount: fillers, speakingSeconds: seconds,
    wordsPerMinute: seconds > 0 ? Math.round(words / (seconds / 60) * 10) / 10 : 0, fillersPer100Words: total ? Math.round(fillers * 1000 / total) / 10 : 0,
    pauseThresholdSeconds: 1, pausesOverThreshold: Math.floor(words / 40), longestPauseSeconds: words >= 40 ? 1.4 : 0,
    totalPauseSecondsOverThreshold: Math.round(Math.floor(words / 40) * 1.4 * 100) / 100, repetitionCount: 0 };
}

/** A benchmark case's fluency figures and recording length: the recording is the speech plus 2 seconds (never shorter than the speech). */
function caseRecording(item) {
  const fluency = fluencyFor(item.text, item.fluency || {});
  return { fluency, seconds: item.seconds || Math.max(6, Math.ceil(fluency.speakingSeconds) + 2) };
}

/** A ready, linked recording whose stored derived texts hold `text` (as the transcription worker stores them). */
async function readyRecording(f, text, { fluency = fluencyFor(text), seconds = 60 } = {}) {
  const made = await makeAudioSubmission(f, { status: 'ready', seconds });
  await AudioRecording.collection.updateOne({ _id: made.recording._id }, { $set: { derived: { derivedTextVersion: 'audio-derived-text-v1',
    displayText: { text, fillers: [] }, assessorText: text, fluency }, transcriptSchemaVersion: 'audio-transcript-v1', wordTimingsAvailable: true } });
  return made;
}

/** Repeats varied sentences up to about `words` words (a long answer within the 7 minute cap). */
function longAnswer(words) {
  const sentences = ['My town is next to a wide river and there are many old bridges.', 'On weekends people walk along the river and buy fresh fish.',
    'The market opens early and the streets are busy with bicycles.', 'In the evening families sit outside and talk with their neighbours.',
    'Last year the council builded a new library near the station.', 'I think the best place is the park because it is quiet and green.'];
  const out = [];
  for (let i = 0; out.join(' ').split(' ').length < words; i++) out.push(sentences[i % sentences.length]);
  return out.join(' ');
}

module.exports = { MODEL, TEST_ENV, DEFAULT_IDS, output, fakeOpenRouter, personalCredits, institutionCredits, fluencyFor, caseRecording, readyRecording, longAnswer,
  objectId: () => new mongoose.Types.ObjectId() };
