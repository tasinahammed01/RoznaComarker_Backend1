'use strict';
// Speaking assignments (resourceType 'speaking', audio + speech-to-text). Created only while AUDIO_STT_ENABLED is on. Their own settings:
//   speaking.maxRecordingSeconds  whole seconds, 10 .. AUDIO_MAX_DURATION_SECONDS; null = the policy limit at upload time
//   speaking.rubricRef            one of the teacher's own active saved rubrics, kept for the marking stage (not used yet)
// Essay rubric fields, resubmission and late resubmission do not apply and are not stored.
const mongoose = require('mongoose');
const { audioSttEnabled, readLimits } = require('./policy');

const MIN_RECORDING_SECONDS = 10;
const isSpeaking = assignment => assignment?.resourceType === 'speaking';
const fail = (code, message) => Object.assign(new Error(message), { statusCode: 400, code });

/** The resource types a teacher may create now (speaking only while the feature is on). */
const creatableTypes = (env = process.env) => ['essay', 'flashcard', 'worksheet', ...(audioSttEnabled(env) ? ['speaking'] : [])];

/**
 * Validates the `speaking` body object. `current` is the stored settings (update) or undefined (create). Returns the settings to store.
 * Throws { statusCode: 400, code } on a bad value. Fields left out keep their current value.
 */
async function parseSpeakingSettings(input, { teacherId, current, env = process.env } = {}) {
  const value = input == null ? {} : input;
  if (typeof value !== 'object' || Array.isArray(value)) throw fail('SPEAKING_SETTINGS_INVALID', 'speaking must be an object');
  const { limits } = readLimits(env);
  const out = { maxRecordingSeconds: current?.maxRecordingSeconds ?? null, rubricRef: current?.rubricRef ?? null };
  if ('maxRecordingSeconds' in value) {
    const seconds = value.maxRecordingSeconds;
    if (seconds !== null && !(Number.isInteger(seconds) && seconds >= MIN_RECORDING_SECONDS && seconds <= limits.maxDurationSeconds)) {
      throw fail('SPEAKING_MAX_RECORDING_INVALID', `maxRecordingSeconds must be a whole number from ${MIN_RECORDING_SECONDS} to ${limits.maxDurationSeconds}`);
    }
    out.maxRecordingSeconds = seconds;
  }
  if ('rubricRef' in value) {
    const ref = value.rubricRef;
    if (ref === null) out.rubricRef = null;
    else {
      const found = mongoose.isValidObjectId(ref) && /^[a-f\d]{24}$/i.test(String(ref))
        ? await require('../../models/savedRubric.model').exists({ _id: ref, teacher: teacherId, isActive: true }) : null;
      if (!found) throw fail('SPEAKING_RUBRIC_NOT_FOUND', 'rubricRef must be one of your saved rubrics');
      out.rubricRef = new mongoose.Types.ObjectId(String(ref));
    }
  }
  return out;
}

/** The longest recording this assignment accepts now: its own maximum, never above the policy limit. */
function effectiveMaxRecordingSeconds(assignment, limits = readLimits().limits) {
  const own = assignment?.speaking?.maxRecordingSeconds;
  return Number.isInteger(own) && own > 0 ? Math.min(own, limits.maxDurationSeconds) : limits.maxDurationSeconds;
}

module.exports = { MIN_RECORDING_SECONDS, isSpeaking, creatableTypes, parseSpeakingSettings, effectiveMaxRecordingSeconds };
