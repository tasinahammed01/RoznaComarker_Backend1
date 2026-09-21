'use strict';

const mongoose = require('mongoose');
const { diagnoseTeacherStudentUsage } = require('../src/services/studentQuota.service');

function parseArgs(argv) {
  const teacherArgs = argv.filter(value => value.startsWith('--teacher='));
  const classArgs = argv.filter(value => value.startsWith('--class='));
  if (teacherArgs.length !== 1 || classArgs.length > 1 || teacherArgs.length + classArgs.length !== argv.length) {
    throw new Error('INVALID_ARGUMENTS');
  }
  const teacherId = teacherArgs[0].slice('--teacher='.length);
  if (!mongoose.isObjectIdOrHexString(teacherId)) throw new Error('INVALID_TEACHER_ID');
  const classId = classArgs.length ? classArgs[0].slice('--class='.length) : null;
  if (classId && !mongoose.isObjectIdOrHexString(classId)) throw new Error('INVALID_CLASS_ID');
  return { teacherId, classId };
}

async function main() {
  require('dotenv').config({ quiet: true });
  try {
    const { teacherId, classId } = parseArgs(process.argv.slice(2));
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI_MISSING');
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000 });
    console.log(JSON.stringify(await diagnoseTeacherStudentUsage(teacherId, { classId }), null, 2));
  } catch (error) {
    console.error(`FAIL ${/^[A-Z_]+$/.test(error.message) ? error.message : 'STUDENT_USAGE_DIAGNOSTIC_FAILED'}`);
    process.exitCode = 1;
  } finally { await mongoose.disconnect(); }
}

if (require.main === module) main();
module.exports = { parseArgs };
