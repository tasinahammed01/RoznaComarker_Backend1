const mongoose = require('mongoose');

const WorksheetThemeSchema = new mongoose.Schema({
  primaryColor:    { type: String, default: '#0d9488' },
  accentColor:     { type: String, default: '#99f6e4' },
  backgroundColor: { type: String, default: '#ffffff' },
  headerGradient:  { type: String, default: '' },
  patternType: {
    type: String,
    enum: [
      'none', 'leaves', 'dots', 'stars', 'waves',
      'geometric', 'honeycomb', 'circuit', 'bubbles',
      'grid', 'paws', 'musical-notes', 'molecules',
      'books', 'clouds', 'grass', 'space'
    ],
    default: 'none'
  },
  fontStyle: {
    type: String,
    enum: ['modern', 'friendly', 'classic', 'bold', 'playful'],
    default: 'modern'
  },
  headerStyle: {
    type: String,
    enum: ['flat', 'gradient', 'wave', 'diagonal'],
    default: 'flat'
  },
  iconSet:       { type: String, default: 'default' },
  darkHeader:    { type: Boolean, default: false },
  generatedFor:  { type: String, default: '' },
  colorPalette: {
    correct:         { type: String, default: '#16a34a' },
    wrong:           { type: String, default: '#dc2626' },
    highlight:       { type: String, default: '#fef3c7' },
    cardBackground:  { type: String, default: '#f9fafb' },
    borderColor:     { type: String, default: '#e5e7eb' },
  },
}, { _id: false });

const WorksheetSchema = new mongoose.Schema({
  title:            { type: String, required: true, trim: true },
  description:      { type: String, default: '', maxlength: 500 },
  subject: {
    type: String,
    enum: ['Math', 'Science', 'Biology', 'Chemistry', 'Physics', 'Social Studies', 'English Language', 'ESL',
           'History', 'Geography', 'Arts', 'Music', 'Physical Education',
           'Technology', 'Other', ''],
    default: '',
  },
  cefrLevel: {
    type: String,
    enum: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', null],
    default: null,
  },
  gradeLevel: {
    type: String,
    enum: ['Pre-K', 'K', '1st', '2nd', '3rd', '4th', '5th', '6th',
           '7th', '8th', '9th', '10th', '11th', '12th', 'University', 'Adult', null],
    default: null,
  },
  gradeCategory: {
    type: String,
    enum: ['Early Learning', 'Elementary', 'Middle School', 'High School', 'University', null],
    default: null,
  },
  difficulty: {
    type: String,
    enum: ['Beginner', 'Intermediate', 'Advanced', 'easy', 'medium', 'hard', null],
    default: null,
  },
  assignmentDeadline: { type: Date, required: true },
  tags:             [String],
  estimatedMinutes: { type: Number, default: 20 },
  generationSource: { type: String, enum: ['topic', 'image', 'manual'], default: 'topic' },
  sourceContent:    { type: String, default: '' },
  language:         { type: String, default: 'English' },
  thumbnailUrl:     { type: String, default: null },
  isPublic:         { type: Boolean, default: false },
  shareToken:       { type: String, sparse: true, unique: true },
  createdBy:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  isPublished:      { type: Boolean, default: false },

  conceptExplanation: { type: mongoose.Schema.Types.Mixed, default: null },
  
  // New extensible activities array structure
  activities: [{
    type: { type: String, required: true }, // Activity type ID from activityTypes.config
    title: { type: String, required: true },
    instructions: { type: String, required: true },
    data: { type: mongoose.Schema.Types.Mixed, required: true }, // Activity-specific data
    order: { type: Number, default: 0 }, // Display order
  }],
  
  // Legacy fields for backward compatibility (deprecated but kept for migration)
  activity1:          { type: mongoose.Schema.Types.Mixed, default: null },
  activity2:          { type: mongoose.Schema.Types.Mixed, default: null },
  activity3:          { type: mongoose.Schema.Types.Mixed, default: null },
  activity4:          { type: mongoose.Schema.Types.Mixed, default: null },

  totalPoints: { type: Number, default: 16 },
  theme:       { type: WorksheetThemeSchema, default: () => ({}) },
}, { timestamps: true });

WorksheetSchema.index({ cefrLevel: 1 });
WorksheetSchema.index({ gradeLevel: 1 });
WorksheetSchema.index({ gradeCategory: 1 });
WorksheetSchema.index({ subject: 1 });
WorksheetSchema.index({ createdBy: 1, createdAt: -1 });
WorksheetSchema.index({ title: 'text', description: 'text', tags: 'text' });

module.exports = mongoose.model('Worksheet', WorksheetSchema);
