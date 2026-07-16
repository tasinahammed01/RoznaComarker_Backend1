const {
  buildWritingAssessment,
  EMPTY_ASSESSMENT,
  RUBRIC_MAX,
  ASSESSMENT_VERSION
} = require('../src/services/writingAssessment.service');

describe('writing assessment service', () => {
  test('empty transcript returns zero scores with appropriate comments', async () => {
    const assessment = await buildWritingAssessment({
      submission: {
        _id: 'test-submission-1',
        ocrPages: []
      },
      assignment: {
        title: 'Test Assignment',
        instructions: 'Write an essay'
      },
      transcriptText: '',
      correctionStatistics: {
        content: 0,
        grammar: 0,
        organization: 0,
        vocabulary: 0,
        mechanics: 0,
        total: 0
      }
    });

    expect(assessment.assessmentVersion).toBe(ASSESSMENT_VERSION);
    expect(assessment.overallScore).toBe(0);
    expect(assessment.grade).toBe('F');
    expect(assessment.rubricScores.GRAMMAR.score).toBe(0);
    expect(assessment.rubricScores.GRAMMAR.comment).toContain('No text to evaluate');
    expect(assessment.rubricScores.PRESENTATION.score).toBe(0);
    expect(assessment.evidence.wordCount).toBe(0);
  });

  test('clean multi-paragraph transcript scores well', async () => {
    const cleanTranscript = `This is a well-written essay with multiple paragraphs that demonstrates good writing skills and proper grammar throughout the entire text.

The second paragraph demonstrates good organization and clear structure with proper flow of ideas and logical transitions between different concepts presented in the writing.

Finally, the conclusion summarizes the main points effectively and provides closure to the argument presented in the essay while reinforcing the central thesis of the work.`;

    const assessment = await buildWritingAssessment({
      submission: {
        _id: 'test-submission-2',
        ocrPages: []
      },
      assignment: {
        title: 'Essay Assignment',
        instructions: 'Write a multi-paragraph essay'
      },
      transcriptText: cleanTranscript,
      correctionStatistics: {
        content: 0,
        grammar: 0,
        organization: 0,
        vocabulary: 0,
        mechanics: 0,
        total: 0
      }
    });

    expect(assessment.evidence.wordCount).toBeGreaterThan(50);
    expect(assessment.evidence.paragraphCount).toBe(3);
    expect(assessment.rubricScores.GRAMMAR.score).toBeGreaterThan(RUBRIC_MAX.GRAMMAR * 0.8);
    expect(assessment.rubricScores.ORGANIZATION.score).toBeGreaterThanOrEqual(RUBRIC_MAX.ORGANIZATION * 0.5);
    expect(assessment.rubricScores.MECHANICS.score).toBeGreaterThan(RUBRIC_MAX.MECHANICS * 0.8);
  });

  test('grammar-heavy transcript reduces grammar score appropriately', async () => {
    const grammarHeavyTranscript = `This are a test with many grammar error. She don't like it. They was going to the store. I has a cat. We was happy.`;

    const assessment = await buildWritingAssessment({
      submission: {
        _id: 'test-submission-3',
        ocrPages: []
      },
      assignment: {
        title: 'Grammar Test'
      },
      transcriptText: grammarHeavyTranscript,
      correctionStatistics: {
        content: 0,
        grammar: 5,
        organization: 0,
        vocabulary: 0,
        mechanics: 0,
        total: 5
      }
    });

    expect(assessment.rubricScores.GRAMMAR.score).toBeLessThan(RUBRIC_MAX.GRAMMAR * 0.7);
    expect(assessment.rubricScores.GRAMMAR.comment).toContain('5 grammar issue');
    expect(assessment.evidence.correctionCounts.grammar).toBe(5);
  });

  test('mechanics-heavy transcript reduces mechanics score appropriately', async () => {
    const mechanicsHeavyTranscript = `This is a test with speling erors and bad punctuation, capitalization issues and typografy problems`;

    const assessment = await buildWritingAssessment({
      submission: {
        _id: 'test-submission-4',
        ocrPages: []
      },
      assignment: {
        title: 'Mechanics Test'
      },
      transcriptText: mechanicsHeavyTranscript,
      correctionStatistics: {
        content: 0,
        grammar: 0,
        organization: 0,
        vocabulary: 0,
        mechanics: 4,
        total: 4
      }
    });

    expect(assessment.rubricScores.MECHANICS.score).toBeLessThan(RUBRIC_MAX.MECHANICS * 0.7);
    expect(assessment.rubricScores.MECHANICS.comment).toContain('4 mechanics issue');
    expect(assessment.evidence.correctionCounts.mechanics).toBe(4);
  });

  test('vocabulary findings reduce vocabulary score appropriately', async () => {
    const repetitiveTranscript = 'good '.repeat(100) + 'This is a test with limited vocabulary variety and repetitive word usage.';
    
    const assessment = await buildWritingAssessment({
      submission: {
        _id: 'test-submission-5',
        ocrPages: []
      },
      assignment: {
        title: 'Vocabulary Test'
      },
      transcriptText: repetitiveTranscript,
      correctionStatistics: {
        content: 0,
        grammar: 0,
        organization: 0,
        vocabulary: 2,
        mechanics: 0,
        total: 2
      }
    });

    expect(assessment.rubricScores.VOCABULARY.score).toBeLessThan(RUBRIC_MAX.VOCABULARY * 0.9);
    expect(assessment.rubricScores.VOCABULARY.comment).toContain('vocabulary issue');
    expect(assessment.evidence.correctionCounts.vocabulary).toBe(2);
  });


  test('missing assignment instructions produces conservative content score', async () => {
    const assessment = await buildWritingAssessment({
      submission: {
        _id: 'test-submission-8',
        ocrPages: []
      },
      assignment: {
        title: 'Test Assignment'
      },
      transcriptText: 'This is a reasonable response with good content that demonstrates understanding of the topic and provides sufficient detail for the assignment requirements. The student has addressed the main points effectively and shows good comprehension of the subject matter.',
      correctionStatistics: {
        content: 0,
        grammar: 0,
        organization: 0,
        vocabulary: 0,
        mechanics: 0,
        total: 0
      }
    });

    expect(assessment.evidence.assignmentPromptAvailable).toBe(false);
    expect(assessment.rubricScores.CONTENT.comment).toContain('assignment prompt not available');
    expect(assessment.rubricScores.CONTENT.comment).toContain('Semantic prompt alignment requires AI evaluation');
  });

  test('assignment with instructions uses conservative completion evidence', async () => {
    const assessment = await buildWritingAssessment({
      submission: {
        _id: 'test-submission-8b',
        ocrPages: []
      },
      assignment: {
        title: 'Test Assignment',
        instructions: 'Write a detailed essay about climate change.'
      },
      transcriptText: 'This is a reasonable response with good content.',
      correctionStatistics: {
        content: 0,
        grammar: 0,
        organization: 0,
        vocabulary: 0,
        mechanics: 0,
        total: 0
      }
    });

    expect(assessment.evidence.assignmentPromptAvailable).toBe(true);
    expect(assessment.rubricScores.CONTENT.comment).toContain('Conservative completion evidence');
    expect(assessment.rubricScores.CONTENT.comment).toContain('Semantic prompt alignment and task achievement require AI evaluation');
  });

  test('overall score equals exact category sum', async () => {
    const assessment = await buildWritingAssessment({
      submission: {
        _id: 'test-submission-9',
        ocrPages: []
      },
      assignment: {
        title: 'Score Sum Test',
        instructions: 'Write an essay'
      },
      transcriptText: 'This is a test response for scoring.',
      correctionStatistics: {
        content: 1,
        grammar: 2,
        organization: 1,
        vocabulary: 1,
        mechanics: 1,
        total: 6
      }
    });

    const categorySum = Object.values(assessment.rubricScores).reduce((sum, cat) => sum + cat.score, 0);
    expect(assessment.overallScore).toBe(categorySum);
    expect(assessment.overallScore).toBeLessThanOrEqual(100);
  });

  test('every category remains within its maximum', async () => {
    const assessment = await buildWritingAssessment({
      submission: {
        _id: 'test-submission-10',
        ocrPages: []
      },
      assignment: {
        title: 'Max Score Test'
      },
      transcriptText: 'Test content.',
      correctionStatistics: {
        content: 0,
        grammar: 0,
        organization: 0,
        vocabulary: 0,
        mechanics: 0,
        total: 0
      }
    });

    expect(assessment.rubricScores.GRAMMAR.score).toBeLessThanOrEqual(RUBRIC_MAX.GRAMMAR);
    expect(assessment.rubricScores.VOCABULARY.score).toBeLessThanOrEqual(RUBRIC_MAX.VOCABULARY);
    expect(assessment.rubricScores.ORGANIZATION.score).toBeLessThanOrEqual(RUBRIC_MAX.ORGANIZATION);
    expect(assessment.rubricScores.CONTENT.score).toBeLessThanOrEqual(RUBRIC_MAX.CONTENT);
    expect(assessment.rubricScores.MECHANICS.score).toBeLessThanOrEqual(RUBRIC_MAX.MECHANICS);
    expect(assessment.rubricScores.PRESENTATION.score).toBeLessThanOrEqual(RUBRIC_MAX.PRESENTATION);
  });

  test('unknown corrections do not become Content issues', async () => {
    const assessment = await buildWritingAssessment({
      submission: {
        _id: 'test-submission-11',
        ocrPages: []
      },
      assignment: {
        title: 'Unknown Group Test'
      },
      transcriptText: 'Test content.',
      correctionStatistics: {
        content: 0,
        grammar: 1,
        organization: 0,
        vocabulary: 0,
        mechanics: 1,
        total: 2
      }
    });

    expect(assessment.evidence.correctionCounts.content).toBe(0);
    expect(assessment.evidence.correctionCounts.total).toBe(2);
  });

  test('original transcript is graded instead of corrected text', async () => {
    const originalTranscript = 'This are grammar errors in the original text.';
    
    const assessment = await buildWritingAssessment({
      submission: {
        _id: 'test-submission-12',
        ocrPages: []
      },
      assignment: {
        title: 'Original Text Test'
      },
      transcriptText: originalTranscript,
      correctionStatistics: {
        content: 0,
        grammar: 2,
        organization: 0,
        vocabulary: 0,
        mechanics: 0,
        total: 2
      }
    });

    expect(assessment.evidence.wordCount).toBeGreaterThan(0);
    expect(assessment.rubricScores.GRAMMAR.score).toBeLessThan(RUBRIC_MAX.GRAMMAR);
  });
});
