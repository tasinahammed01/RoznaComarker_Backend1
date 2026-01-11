const mongoose = require('mongoose');

const { Schema } = mongoose;

const assignmentSchema = new Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true
    },
    instructions: {
      type: String,
      trim: true
    },
    rubric: {
      type: String
    },
    deadline: {
      type: Date,
      required: true
    },
    class: {
      type: Schema.Types.ObjectId,
      ref: 'Class',
      required: true,
      index: true
    },
    teacher: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    qrToken: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
      trim: true
    },
    allowLateResubmission: {
      type: Boolean,
      default: false
    },
    isActive: {
      type: Boolean,
      default: true
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model('Assignment', assignmentSchema);
