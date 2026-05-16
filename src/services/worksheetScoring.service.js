const normalizeString = (v) => String(v ?? '').trim();

function lowerTrim(v) {
  return normalizeString(v).toLowerCase();
}

function buildAnswerKeyMaps(worksheet) {
  // Check if worksheet uses the new activities array format
  const activitiesArray = worksheet?.activities ?? [];
  const usesActivitiesFormat = Array.isArray(activitiesArray) && activitiesArray.length > 0;

  let a1Items = worksheet?.activity1?.items ?? [];
  let a2Items = worksheet?.activity2?.items ?? [];
  let a3Qs = worksheet?.activity3?.questions ?? [];
  let a4Sents = worksheet?.activity4?.sentences ?? [];
  let a5Pairs = worksheet?.activity5?.pairs ?? [];
  let a6Qs = worksheet?.activity6?.questions ?? [];

  // Map to track which sectionId each activity type maps to (for new format)
  const sectionIdMap = new Map();

  // Extract from new activities array format if present
  if (usesActivitiesFormat) {
    activitiesArray.forEach((activity, index) => {
      const data = activity?.data || {};
      const type = activity?.type || '';
      const sectionId = `activity_${index}`;

      if (type === 'ordering' || type === 'dragDrop' || type === 'sorting') {
        a1Items = data?.items ?? [];
        sectionIdMap.set('activity1', sectionId);
      } else if (type === 'classification') {
        a2Items = data?.items ?? [];
        sectionIdMap.set('activity2', sectionId);
      } else if (type === 'multipleChoice') {
        a3Qs = data?.questions ?? [];
        sectionIdMap.set('activity3', sectionId);
      } else if (type === 'fillBlanks') {
        a4Sents = data?.sentences ?? [];
        sectionIdMap.set('activity4', sectionId);
      } else if (type === 'matching') {
        a5Pairs = data?.pairs ?? [];
        sectionIdMap.set('activity5', sectionId);
      } else if (type === 'trueFalse') {
        a6Qs = data?.questions ?? [];
        sectionIdMap.set('activity6', sectionId);
      }
    });
  }

  const a1BySlot = new Map();
  for (const item of a1Items) {
    if (item && item.correctOrder != null) {
      a1BySlot.set(Number(item.correctOrder) - 1, item);
    }
  }

  const a2ById = new Map();
  for (const item of a2Items) {
    if (item && item.id != null) {
      a2ById.set(String(item.id), item);
    }
  }

  const a3ByQid = new Map();
  for (const q of a3Qs) {
    if (q && q.id != null) {
      a3ByQid.set(String(q.id), q);
    }
  }

  const a4ByBlankId = new Map();
  for (const s of a4Sents) {
    for (const p of s?.parts ?? []) {
      if (p && p.type === 'blank' && p.blankId != null) {
        a4ByBlankId.set(String(p.blankId), p);
      }
    }
  }

  const a4BlankCount = Array.from(a4ByBlankId.keys()).length;

  // Activity 5: Matching pairs - map pairId to correct match
  const a5ByPairId = new Map();
  for (const pair of a5Pairs) {
    if (pair && pair.pairId != null) {
      a5ByPairId.set(String(pair.pairId), pair);
    }
  }

  // Activity 6: True/False - map questionId to correct answer
  const a6ByQid = new Map();
  for (const q of a6Qs) {
    if (q && q.id != null) {
      a6ByQid.set(String(q.id), q);
    }
  }

  // Support new activities array format
  const activitiesByIndex = new Map();
  for (let i = 0; i < activitiesArray.length; i++) {
    activitiesByIndex.set(i, activitiesArray[i]);
  }

  return {
    a1Items,
    a2Items,
    a3Qs,
    a4Sents,
    a5Pairs,
    a6Qs,
    a1BySlot,
    a2ById,
    a3ByQid,
    a4ByBlankId,
    a4BlankCount,
    a5ByPairId,
    a6ByQid,
    activitiesArray,
    activitiesByIndex,
    sectionIdMap,
  };
}

function gradeWorksheetAnswers({ worksheet, answers }) {
  const normalizedAnswers = Array.isArray(answers) ? answers : [];
  const {
    a1Items,
    a2Items,
    a3Qs,
    a5Pairs,
    a6Qs,
    a1BySlot,
    a2ById,
    a3ByQid,
    a4ByBlankId,
    a4BlankCount,
    a5ByPairId,
    a6ByQid,
    sectionIdMap,
  } = buildAnswerKeyMaps(worksheet);

  // Helper to normalize sectionId - map activity_N to activity type
  const normalizeSectionId = (sectionId) => {
    // If it's already activity1-6, return as-is
    if (/^activity[1-6]$/.test(sectionId)) return sectionId;
    // If it's activity_0, activity_1, etc., map to activity type based on sectionIdMap
    if (sectionIdMap && sectionIdMap.has(sectionId)) {
      // Reverse lookup: find which activity type this sectionId maps to
      for (const [activityType, mappedSectionId] of sectionIdMap.entries()) {
        if (mappedSectionId === sectionId) return activityType;
      }
    }
    return sectionId;
  };

  const graded = normalizedAnswers.map((a) => {
    const sectionId = normalizeSectionId(normalizeString(a?.sectionId));
    const questionId = normalizeString(a?.questionId);
    const studentAnswer = normalizeString(a?.studentAnswer);

    let isCorrect = false;
    let feedback = 'Incorrect.';

    if (sectionId === 'activity1') {
      const slotIdx = parseInt(questionId.replace('slot_', ''), 10);
      const correctItem = a1BySlot.get(slotIdx);
      isCorrect = Boolean(correctItem && String(correctItem.id) === studentAnswer);
      feedback = isCorrect ? 'Correct!' : `Incorrect. Correct item: ${correctItem?.id ?? '?'}`;
    } else if (sectionId === 'activity2') {
      const item = a2ById.get(questionId);
      const correctCategory = normalizeString(item?.correctCategory);
      isCorrect = Boolean(item && lowerTrim(studentAnswer) && lowerTrim(studentAnswer) === lowerTrim(correctCategory));
      feedback = isCorrect ? 'Correct!' : `Incorrect. Correct: ${correctCategory || '?'}`;
    } else if (sectionId === 'activity3') {
      const q = a3ByQid.get(questionId);
      isCorrect = Boolean(q && normalizeString(q.correctAnswer) === studentAnswer);
      feedback = isCorrect ? 'Correct!' : `Incorrect. Correct: ${q?.correctAnswer ?? '?'}`;
    } else if (sectionId === 'activity4') {
      const part = a4ByBlankId.get(questionId);
      const correct = lowerTrim(part?.correctAnswer);
      const given = lowerTrim(studentAnswer);
      isCorrect = Boolean(part && correct && given && given === correct);
      feedback = isCorrect ? 'Correct!' : `Incorrect. Correct: ${part?.correctAnswer ?? '?'}`;
    } else if (sectionId === 'activity5') {
      // Activity 5: Matching pairs
      const pair = a5ByPairId.get(questionId);
      const correctMatch = normalizeString(pair?.rightItem?.text || pair?.correctMatch);
      const givenMatch = lowerTrim(studentAnswer);
      isCorrect = Boolean(pair && correctMatch && givenMatch && givenMatch === lowerTrim(correctMatch));
      feedback = isCorrect ? 'Correct match!' : `Incorrect. Correct match: ${correctMatch || '?'}`;
    } else if (sectionId === 'activity6') {
      // Activity 6: True/False
      const q = a6ByQid.get(questionId);
      const correctAnswer = normalizeString(q?.correctAnswer); // Should be 'true' or 'false'
      const givenAnswer = lowerTrim(studentAnswer);
      isCorrect = Boolean(q && correctAnswer && givenAnswer && givenAnswer === lowerTrim(correctAnswer));
      feedback = isCorrect ? 'Correct!' : `Incorrect. Correct: ${correctAnswer || '?'}`;
    } else {
      // Fallback for activities array format or other types
      isCorrect = Boolean(a?.isCorrect);
      feedback = isCorrect ? 'Correct!' : 'Incorrect.';
    }

    return {
      questionId,
      sectionId,
      studentAnswer,
      isCorrect,
      pointsEarned: isCorrect ? 1 : 0,
      aiGradingFeedback: feedback,
    };
  });

  const totalPointsEarned = graded.reduce((s, a) => s + (Number(a.pointsEarned) || 0), 0);

  const totalPointsPossible =
    (Array.isArray(a1Items) ? a1Items.length : 0) +
    (Array.isArray(a2Items) ? a2Items.length : 0) +
    (Array.isArray(a3Qs) ? a3Qs.length : 0) +
    (Number(a4BlankCount) || 0) +
    (Array.isArray(a5Pairs) ? a5Pairs.length : 0) +
    (Array.isArray(a6Qs) ? a6Qs.length : 0);

  const percentage = totalPointsPossible > 0
    ? Math.round((totalPointsEarned / totalPointsPossible) * 100)
    : 0;

  const breakdown = {
    activity1: { earned: 0, possible: Array.isArray(a1Items) ? a1Items.length : 0 },
    activity2: { earned: 0, possible: Array.isArray(a2Items) ? a2Items.length : 0 },
    activity3: { earned: 0, possible: Array.isArray(a3Qs) ? a3Qs.length : 0 },
    activity4: { earned: 0, possible: Number(a4BlankCount) || 0 },
    activity5: { earned: 0, possible: Array.isArray(a5Pairs) ? a5Pairs.length : 0 },
    activity6: { earned: 0, possible: Array.isArray(a6Qs) ? a6Qs.length : 0 },
  };

  for (const a of graded) {
    if (!a || a.pointsEarned !== 1) continue;
    // Normalize sectionId for breakdown tracking
    const normalizedSectionId = normalizeSectionId(a.sectionId);
    if (normalizedSectionId === 'activity1') breakdown.activity1.earned += 1;
    else if (normalizedSectionId === 'activity2') breakdown.activity2.earned += 1;
    else if (normalizedSectionId === 'activity3') breakdown.activity3.earned += 1;
    else if (normalizedSectionId === 'activity4') breakdown.activity4.earned += 1;
    else if (normalizedSectionId === 'activity5') breakdown.activity5.earned += 1;
    else if (normalizedSectionId === 'activity6') breakdown.activity6.earned += 1;
  }

  return {
    gradedAnswers: graded,
    totals: {
      totalPointsEarned,
      totalPointsPossible,
      percentage,
      breakdown,
    },
  };
}

function buildCanonicalAnswerSheet({ worksheet, answersBySection }) {
  const ws = worksheet && typeof worksheet === 'object' ? worksheet : {};
  const bySection = answersBySection && typeof answersBySection === 'object' ? answersBySection : {};

  const out = [];

  const a1Items = ws.activity1?.items ?? [];
  for (let i = 0; i < a1Items.length; i++) {
    const studentAnswer = normalizeString(bySection?.activity1?.[i] ?? '');
    out.push({ questionId: `slot_${i}`, sectionId: 'activity1', studentAnswer });
  }

  const a2Items = ws.activity2?.items ?? [];
  for (const item of a2Items) {
    const id = item && item.id != null ? String(item.id) : '';
    if (!id) continue;
    const studentAnswer = normalizeString(bySection?.activity2?.[id] ?? '');
    out.push({ questionId: id, sectionId: 'activity2', studentAnswer });
  }

  const a3Qs = ws.activity3?.questions ?? [];
  for (const q of a3Qs) {
    const id = q && q.id != null ? String(q.id) : '';
    if (!id) continue;
    const studentAnswer = normalizeString(bySection?.activity3?.[id] ?? '');
    out.push({ questionId: id, sectionId: 'activity3', studentAnswer });
  }

  const sents = ws.activity4?.sentences ?? [];
  for (const s of sents) {
    for (const p of s?.parts ?? []) {
      if (!p || p.type !== 'blank' || p.blankId == null) continue;
      const blankId = String(p.blankId);
      const studentAnswer = normalizeString(bySection?.activity4?.[blankId] ?? '');
      out.push({ questionId: blankId, sectionId: 'activity4', studentAnswer });
    }
  }

  if (Array.isArray(bySection?.extraAnswers)) {
    for (const a of bySection.extraAnswers) {
      if (!a) continue;
      const questionId = normalizeString(a.questionId);
      const sectionId = normalizeString(a.sectionId);
      if (!questionId || !sectionId) continue;
      out.push({ questionId, sectionId, studentAnswer: normalizeString(a.studentAnswer) });
    }
  }

  return out;
}

module.exports = {
  gradeWorksheetAnswers,
  buildCanonicalAnswerSheet,
};
