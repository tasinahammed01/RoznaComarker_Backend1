const mongoose = require('mongoose');

const { Schema } = mongoose;

const flashCardSchema = new Schema(
  {
    front: { type: String, required: true },
    back: { type: String, required: true },
    frontImage: { type: String, default: null },
    backImage: { type: String, default: null },
    order: { type: Number, default: 0 },
    template: { type: String, enum: ['term-def', 'qa', 'concept'], default: 'term-def' }
  }
);

 const flashcardSetSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    visibility: { type: String, enum: ['public', 'private'], default: 'public' },
    folderId: { type: Schema.Types.ObjectId, ref: 'Folder', default: null },
    language: { type: String, default: 'English' },
    template: { type: String, enum: ['term-def', 'qa', 'concept'], default: 'term-def' },
    cards: [flashCardSchema],
    assignedClasses: [{ type: Schema.Types.ObjectId, ref: 'Class' }],
    /** PART 2 — public share link fields */
    shareToken: { type: String, default: undefined },
    isPublic:   { type: Boolean, default: false }
  },
  {
    timestamps: true
  }
);

flashcardSetSchema.index({ ownerId: 1 });
flashcardSetSchema.index({ visibility: 1 });
flashcardSetSchema.index(
  { shareToken: 1 },
  { unique: true, partialFilterExpression: { shareToken: { $type: 'string' } } }
);

module.exports = mongoose.model('FlashcardSet', flashcardSetSchema);
