const normalizeString = (v) => String(v ?? '').trim();

function lowerTrim(v) {
  return normalizeString(v).toLowerCase();
}

function buildAnswerKeyMaps(worksheet) {
  const a1Items = worksheet?.activity1?.items ?? [];
  const a2Items = worksheet?.activity2?.items ?? [];
  const a3Qs = worksheet?.activity3?.questions ?? [];
  const a4Sents = worksheet?.activity4?.sentences ?? [];

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

  return {
    a1Items,
    a2Items,
    a3Qs,
    a4Sents,
    a1BySlot,
    a2ById,
    a3ByQid,
    a4ByBlankId,
    a4BlankCount,
  };
}

function gradeWorksheetAnswers({ worksheet, answers }) {
  const normalizedAnswers = Array.isArray(answers) ? answers : [];
  const {
    a1Items,
    a2Items,
    a3Qs,
    a1BySlot,
    a2ById,
    a3ByQid,
    a4ByBlankId,
    a4BlankCount,
  } = buildAnswerKeyMaps(worksheet);

  const graded = normalizedAnswers.map((a) => {
    const sectionId = normalizeString(a?.sectionId);
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
    } else {
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
    (Number(a4BlankCount) || 0);

  const percentage = totalPointsPossible > 0
    ? Math.round((totalPointsEarned / totalPointsPossible) * 100)
    : 0;

  const breakdown = {
    activity1: { earned: 0, possible: Array.isArray(a1Items) ? a1Items.length : 0 },
    activity2: { earned: 0, possible: Array.isArray(a2Items) ? a2Items.length : 0 },
    activity3: { earned: 0, possible: Array.isArray(a3Qs) ? a3Qs.length : 0 },
    activity4: { earned: 0, possible: Number(a4BlankCount) || 0 },
  };

  for (const a of graded) {
    if (!a || a.pointsEarned !== 1) continue;
    if (a.sectionId === 'activity1') breakdown.activity1.earned += 1;
    else if (a.sectionId === 'activity2') breakdown.activity2.earned += 1;
    else if (a.sectionId === 'activity3') breakdown.activity3.earned += 1;
    else if (a.sectionId === 'activity4') breakdown.activity4.earned += 1;
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
