/**
 * activityTypes.config.js
 *
 * Extensible activity type registry for worksheet generation.
 * Defines supported activity types, their data structures, and AI generation instructions.
 */

const ACTIVITY_TYPES = {
  // Activity 1: Ordering/Sequencing
  ordering: {
    id: 'ordering',
    label: 'Ordering/Sequencing',
    description: 'Arrange items in the correct sequence or order',
    aiInstruction: 'Create a sequencing activity where students arrange items in the correct order. Each item should have an emoji, name, role/description, and a correctOrder (1-based integer).',
    dataStructure: {
      title: 'string',
      instructions: 'string',
      items: [
        {
          id: 'string',
          emoji: 'string',
          name: 'string',
          role: 'string',
          correctOrder: 'number'
        }
      ]
    },
    minItems: 4,
    maxItems: 8
  },

  // Activity 2: Classification/Categorization
  classification: {
    id: 'classification',
    label: 'Classification/Categorization',
    description: 'Classify items into categories',
    aiInstruction: 'Create a classification activity where students categorize items into groups. Define 3-4 categories, and create items that belong to each category.',
    dataStructure: {
      title: 'string',
      instructions: 'string',
      categories: ['string'],
      items: [
        {
          id: 'string',
          emoji: 'string',
          name: 'string',
          description: 'string',
          correctCategory: 'string'
        }
      ]
    },
    minItems: 6,
    maxItems: 12
  },

  // Activity 3: Multiple Choice Quiz
  multipleChoice: {
    id: 'multipleChoice',
    label: 'Multiple Choice Quiz',
    description: 'Answer multiple choice questions',
    aiInstruction: 'Create a multiple choice quiz with 3-5 questions. Each question should have exactly 4 options, with one correct answer.',
    dataStructure: {
      title: 'string',
      instructions: 'string',
      questions: [
        {
          id: 'string',
          text: 'string',
          options: ['string'],
          correctAnswer: 'string'
        }
      ]
    },
    minQuestions: 3,
    maxQuestions: 8
  },

  // Activity 4: Fill in the Blanks
  fillBlanks: {
    id: 'fillBlanks',
    label: 'Fill in the Blanks',
    description: 'Complete sentences with missing words',
    aiInstruction: 'Create a fill-in-the-blanks activity with 4-6 sentences. Each sentence should have 1-2 blanks. Provide a word bank with the correct answers.',
    dataStructure: {
      title: 'string',
      instructions: 'string',
      wordBank: ['string'],
      sentences: [
        {
          id: 'string',
          parts: [
            {
              type: 'text',
              value: 'string'
            },
            {
              type: 'blank',
              blankId: 'string',
              correctAnswer: 'string'
            }
          ]
        }
      ]
    },
    minSentences: 4,
    maxSentences: 8
  },

  // Activity 5: Matching Pairs
  matching: {
    id: 'matching',
    label: 'Matching Pairs',
    description: 'Match related items together',
    aiInstruction: 'Create a matching activity with 4-6 pairs of related items (e.g., term-definition, cause-effect, problem-solution).',
    dataStructure: {
      title: 'string',
      instructions: 'string',
      pairs: [
        {
          id: 'string',
          leftItem: {
            text: 'string',
            imageUrl: 'string (optional)'
          },
          rightItem: {
            text: 'string',
            imageUrl: 'string (optional)'
          }
        }
      ]
    },
    minPairs: 4,
    maxPairs: 8
  },

  // Activity 6: True/False
  trueFalse: {
    id: 'trueFalse',
    label: 'True/False',
    description: 'Determine if statements are true or false',
    aiInstruction: 'Create a true/false activity with 5-8 statements. Each statement should have a correct answer (true/false) and a brief explanation.',
    dataStructure: {
      title: 'string',
      instructions: 'string',
      questions: [
        {
          id: 'string',
          text: 'string',
          correctAnswer: 'boolean',
          explanation: 'string'
        }
      ]
    },
    minQuestions: 5,
    maxQuestions: 10
  },

  // Activity 7: Labeling/Diagram
  labeling: {
    id: 'labeling',
    label: 'Labeling/Diagram',
    description: 'Label parts of an image or diagram',
    aiInstruction: 'Create a labeling activity. Provide an image URL (or description if image not available) and labels with coordinates for key parts.',
    dataStructure: {
      title: 'string',
      instructions: 'string',
      imageUrl: 'string',
      labels: [
        {
          id: 'string',
          text: 'string',
          x: 'number',
          y: 'number',
          targetId: 'string'
        }
      ]
    },
    minLabels: 4,
    maxLabels: 10
  },

  // Activity 8: Short Answer
  shortAnswer: {
    id: 'shortAnswer',
    label: 'Short Answer',
    description: 'Write short responses to questions',
    aiInstruction: 'Create a short answer activity with 3-5 questions that require brief written responses (1-3 sentences).',
    dataStructure: {
      title: 'string',
      instructions: 'string',
      questions: [
        {
          id: 'string',
          text: 'string',
          modelAnswer: 'string',
          maxWords: 'number'
        }
      ]
    },
    minQuestions: 3,
    maxQuestions: 6
  },

  // Activity 9: Drag and Drop
  dragDrop: {
    id: 'dragDrop',
    label: 'Drag and Drop',
    description: 'Drag items to correct targets',
    aiInstruction: 'Create a drag-and-drop activity with draggable items and target zones. Each item should have a correct target.',
    dataStructure: {
      title: 'string',
      instructions: 'string',
      items: [
        {
          id: 'string',
          text: 'string',
          emoji: 'string',
          correctTarget: 'string'
        }
      ],
      targets: [
        {
          id: 'string',
          label: 'string',
          category: 'string'
        }
      ]
    },
    minItems: 4,
    maxItems: 8
  },

  // Activity 10: Word Search
  wordSearch: {
    id: 'wordSearch',
    label: 'Word Search',
    description: 'Find hidden words in a grid',
    aiInstruction: 'Create a word search activity with 8-12 vocabulary words related to the topic. Provide the word list and grid size.',
    dataStructure: {
      title: 'string',
      instructions: 'string',
      words: ['string'],
      gridSize: 'number',
      difficulty: 'string'
    },
    minWords: 8,
    maxWords: 15
  },

  // Activity 11: Crossword
  crossword: {
    id: 'crossword',
    label: 'Crossword Puzzle',
    description: 'Complete a crossword puzzle',
    aiInstruction: 'Create a crossword puzzle with 8-12 words. Provide clues for across and down directions.',
    dataStructure: {
      title: 'string',
      instructions: 'string',
      words: [
        {
          word: 'string',
          clue: 'string',
          direction: 'across|down',
          row: 'number',
          col: 'number'
        }
      ]
    },
    minWords: 8,
    maxWords: 15
  },

  // Activity 12: Sorting
  sorting: {
    id: 'sorting',
    label: 'Sorting',
    description: 'Sort items into groups or by criteria',
    aiInstruction: 'Create a sorting activity where students sort items based on given criteria (e.g., size, color, type, time period).',
    dataStructure: {
      title: 'string',
      instructions: 'string',
      criteria: 'string',
      items: [
        {
          id: 'string',
          text: 'string',
          emoji: 'string',
          correctGroup: 'string'
        }
      ]
    },
    minItems: 6,
    maxItems: 12
  }
};

/**
 * Get activity type by ID
 * @param {string} typeId - Activity type ID
 * @returns {Object|null} Activity type config
 */
function getActivityType(typeId) {
  return ACTIVITY_TYPES[typeId] || null;
}

/**
 * Get all activity types
 * @returns {Object} All activity types
 */
function getAllActivityTypes() {
  return ACTIVITY_TYPES;
}

/**
 * Get activity type list for UI selector
 * @returns {Array<{id: string, label: string, description: string}>}
 */
function getActivityTypeList() {
  return Object.values(ACTIVITY_TYPES).map(type => ({
    id: type.id,
    label: type.label,
    description: type.description
  }));
}

/**
 * Get default activity types for auto-selection
 * @returns {string[]} Array of activity type IDs
 */
function getDefaultActivityTypes() {
  return ['ordering', 'classification', 'multipleChoice', 'fillBlanks'];
}

/**
 * Validate activity data structure
 * @param {string} typeId - Activity type ID
 * @param {Object} data - Activity data to validate
 * @returns {boolean} True if valid
 */
function validateActivityData(typeId, data) {
  const type = getActivityType(typeId);
  if (!type) return false;

  // Basic structure validation
  if (!data.title || !data.instructions) return false;

  // Type-specific validation
  switch (typeId) {
    case 'ordering':
      return Array.isArray(data.items) && data.items.length >= type.minItems;
    case 'classification':
      return Array.isArray(data.categories) && Array.isArray(data.items);
    case 'multipleChoice':
      return Array.isArray(data.questions) && data.questions.every(q => 
        Array.isArray(q.options) && q.options.length === 4
      );
    case 'fillBlanks':
      return Array.isArray(data.wordBank) && Array.isArray(data.sentences);
    case 'matching':
      return Array.isArray(data.pairs);
    case 'trueFalse':
      return Array.isArray(data.questions) && data.questions.every(q => 
        typeof q.correctAnswer === 'boolean'
      );
    case 'shortAnswer':
      return Array.isArray(data.questions);
    default:
      return true;
  }
}

module.exports = {
  ACTIVITY_TYPES,
  getActivityType,
  getAllActivityTypes,
  getActivityTypeList,
  getDefaultActivityTypes,
  validateActivityData,
};
