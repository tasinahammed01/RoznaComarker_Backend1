const mongoose = require('mongoose');

const { Schema } = mongoose;

/**
 * StudentFlashcardProgress
 * Tracks real-time progress of a student studying a flashcard set.
 * This is separate from FlashcardSubmission which only records completed sessions.
 */
const studentFlashcardProgressSchema = new Schema(
  {
    studentId: { 
      type: Schema.Types.ObjectId, 
      ref: 'User', 
      required: true,
      index: true 
    },
    flashcardSetId: { 
      type: Schema.Types.ObjectId, 
      ref: 'FlashcardSet', 
      required: true,
      index: true 
    },
    assignmentId: { 
      type: Schema.Types.ObjectId, 
      ref: 'Assignment', 
      default: null,
      index: true 
    },
    classId: { 
      type: Schema.Types.ObjectId, 
      ref: 'Class', 
      default: null,
      index: true 
    },
    status: { 
      type: String, 
      enum: ['not_started', 'in_progress', 'completed'], 
      default: 'not_started',
      index: true 
    },
    totalCards: { 
      type: Number, 
      required: true,
      min: 0 
    },
    completedCards: { 
      type: Number, 
      default: 0,
      min: 0 
    },
    cardsViewed: [{ 
      type: Number,
      description: 'Array of 0-based card indices that have been viewed'
    }],
    lastCardIndex: { 
      type: Number, 
      default: 0,
      min: 0 
    },
    currentCardId: { type: Schema.Types.ObjectId, default: null },
    cardProgress: [{
      cardId: { type: Schema.Types.ObjectId, required: true },
      studentAnswer: { type: String, default: '' },
      selfRating: { type: String, enum: ['knew', 'didnt_know'], default: null },
      isChecked: { type: Boolean, default: false },
      isCorrect: { type: Boolean, default: null },
      gradingMethod: { type: String, enum: ['exact', 'normalized', 'semantic_ai'], default: null },
      checkedAt: { type: Date, default: null },
      completedAt: { type: Date, default: null }
    }],
    revision: { type: Number, default: 0, min: 0 },
    cardResults: {
      type: Map,
      of: {
        type: String,
        enum: ['knew', 'didnt_know']
      },
      description: 'Map of canonical cardId -> result; legacy documents may use cardIndex keys'
    },
    startedAt: { 
      type: Date, 
      default: null 
    },
    lastActivityAt: { 
      type: Date, 
      default: Date.now,
      index: true 
    },
    completedAt: { 
      type: Date, 
      default: null 
    },
    template: { 
      type: String, 
      enum: ['term-def', 'qa', 'concept'], 
      default: 'term-def' 
    }
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

// Compound unique index: one progress record per student per set per assignment
studentFlashcardProgressSchema.index(
  { studentId: 1, flashcardSetId: 1, assignmentId: 1 }, 
  { unique: true, partialFilterExpression: { assignmentId: { $ne: null } } }
);

// For non-assignment study (teacher self-study, shared links)
studentFlashcardProgressSchema.index(
  { studentId: 1, flashcardSetId: 1 }, 
  { unique: true, partialFilterExpression: { assignmentId: null } }
);

// Index for teacher report queries
studentFlashcardProgressSchema.index({ assignmentId: 1, status: 1 });
studentFlashcardProgressSchema.index({ classId: 1, status: 1 });

// Pre-save hook to auto-calculate completedCards and manage status transitions
studentFlashcardProgressSchema.pre('save', function() {
  const completedIds = new Set((this.cardProgress || [])
    .filter((item) => this.template === 'qa' ? item.isChecked === true : Boolean(item.selfRating))
    .map((item) => String(item.cardId)));
  this.completedCards = Math.min(completedIds.size, this.totalCards || 0);
  this.lastCardIndex = Math.min(Math.max(this.lastCardIndex || 0, 0), Math.max((this.totalCards || 0) - 1, 0));
  
  // Auto-update status based on progress
  if (this.totalCards > 0 && this.completedCards >= this.totalCards) {
    if (this.status !== 'completed') {
      this.status = 'completed';
      if (!this.completedAt) {
        this.completedAt = new Date();
      }
    }
  } else if (this.completedCards > 0) {
    this.status = 'in_progress';
    if (!this.startedAt) {
      this.startedAt = new Date();
    }
  } else {
    this.status = 'not_started';
    this.completedAt = null;
  }
  
  // Update lastActivityAt
  this.lastActivityAt = new Date();
  
});

// Pre-update hook for findOneAndUpdate operations
studentFlashcardProgressSchema.pre('findOneAndUpdate', function() {
  const update = this.getUpdate();
  
  // If cardsViewed is being updated, recalculate completedCards
  if (update.$set && update.$set.cardsViewed) {
    update.$set.cardsViewed = [...new Set(update.$set.cardsViewed)]
      .filter((index) => Number.isInteger(index) && index >= 0 && index < (update.$set.totalCards || Infinity));
    update.$set.completedCards = Math.min(update.$set.cardsViewed.length, update.$set.totalCards || update.$set.cardsViewed.length);
    update.$set.lastCardIndex = Math.min(Math.max(update.$set.lastCardIndex || 0, 0),
      Math.max((update.$set.totalCards || 0) - 1, 0));
    
    // Auto-update status based on progress
    const totalCards = update.$set.totalCards || this._conditions.totalCards;
    if (totalCards > 0 && update.$set.cardsViewed.length >= totalCards) {
      update.$set.status = 'completed';
      if (!update.$set.completedAt) {
        update.$set.completedAt = new Date();
      }
    } else if (update.$set.cardsViewed.length > 0) {
      if (update.$set.status === 'not_started') {
        update.$set.status = 'in_progress';
      }
      if (!update.$set.startedAt) {
        update.$set.startedAt = new Date();
      }
    }
  }
  
  // Always update lastActivityAt
  if (!update.$set) update.$set = {};
  update.$set.lastActivityAt = new Date();
  
});

// Virtual for cards remaining
studentFlashcardProgressSchema.virtual('cardsRemaining').get(function() {
  return Math.max(0, this.totalCards - this.completedCards);
});

// Virtual for progress percentage
studentFlashcardProgressSchema.virtual('progressPercentage').get(function() {
  return this.totalCards > 0 ? Math.round((this.completedCards / this.totalCards) * 100) : 0;
});

// Method to add a viewed card (prevents duplicates)
studentFlashcardProgressSchema.methods.addViewedCard = function(cardIndex) {
  if (!this.cardsViewed.includes(cardIndex)) {
    this.cardsViewed.push(cardIndex);
    this.completedCards = this.cardsViewed.length;
    this.lastCardIndex = cardIndex;
    
    // Check for completion
    if (this.totalCards > 0 && this.completedCards >= this.totalCards) {
      this.status = 'completed';
      if (!this.completedAt) {
        this.completedAt = new Date();
      }
    } else if (this.status === 'not_started') {
      this.status = 'in_progress';
      if (!this.startedAt) {
        this.startedAt = new Date();
      }
    }
  } else {
    // Just update lastCardIndex if already viewed
    this.lastCardIndex = cardIndex;
  }
  
  this.lastActivityAt = new Date();
};

// Method to record card result
studentFlashcardProgressSchema.methods.recordCardResult = function(cardIndex, result) {
  if (!this.cardResults) {
    this.cardResults = new Map();
  }
  this.cardResults.set(String(cardIndex), result);
};

// Method to reset progress (for "Start Over")
studentFlashcardProgressSchema.methods.resetProgress = function() {
  this.cardsViewed = [];
  this.completedCards = 0;
  this.lastCardIndex = 0;
  this.cardResults = new Map();
  this.status = 'not_started';
  this.startedAt = null;
  this.completedAt = null;
  this.lastActivityAt = new Date();
};

module.exports = mongoose.model('StudentFlashcardProgress', studentFlashcardProgressSchema);
