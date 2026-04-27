const mongoose = require('mongoose');

const WorksheetSchema = new mongoose.Schema({
  title:            { type: String, required: true, trim: true },
  description:      { type: String, default: '' },
  subject:          { type: String, default: '' },
  tags:             [String],
  estimatedMinutes: { type: Number, default: 20 },
  generationSource: { type: String, enum: ['topic', 'image', 'manual'], default: 'topic' },
  sourceContent:    { type: String, default: '' },
  language:         { type: String, default: 'English' },
  difficulty:       { type: String, default: 'medium' },
  createdBy:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  isPublished:      { type: Boolean, default: false },

  conceptExplanation: { type: mongoose.Schema.Types.Mixed, default: null },
  activity1:          { type: mongoose.Schema.Types.Mixed, default: null },
  activity2:          { type: mongoose.Schema.Types.Mixed, default: null },
  activity3:          { type: mongoose.Schema.Types.Mixed, default: null },
  activity4:          { type: mongoose.Schema.Types.Mixed, default: null },

  totalPoints: { type: Number, default: 16 },
}, { timestamps: true });

module.exports = mongoose.model('Worksheet', WorksheetSchema);
