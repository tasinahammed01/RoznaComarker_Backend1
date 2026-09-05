const mongoose = require('mongoose');

const { Schema } = mongoose;

const levelSchema = new Schema({
  title: { type: String, required: true, trim: true },
  score: { type: Number, required: true },
  description: { type: String, required: true, trim: true }
}, { _id: false });

const criterionSchema = new Schema({
  name: { type: String, required: true, trim: true },
  weight: { type: Number, required: true },
  levels: { type: [levelSchema], required: true }
}, { _id: false });

const savedRubricSchema = new Schema({
  teacher: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  description: { type: String, trim: true, maxlength: 1000 },
  writingType: { type: String, trim: true, maxlength: 120 },
  rubricData: {
    type: new Schema({
      totalPoints: { type: Number, required: true },
      criteria: { type: [criterionSchema], required: true }
    }, { _id: false }),
    required: true
  },
  sourceAssignmentId: { type: Schema.Types.ObjectId, ref: 'Assignment', default: null },
  isActive: { type: Boolean, default: true, index: true },
  archivedAt: { type: Date, default: null }
}, { timestamps: true });

savedRubricSchema.index({ teacher: 1, isActive: 1, updatedAt: -1 });

module.exports = mongoose.model('SavedRubric', savedRubricSchema);
