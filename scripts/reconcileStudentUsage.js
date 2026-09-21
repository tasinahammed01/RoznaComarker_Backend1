'use strict';

const mongoose = require('mongoose');
const { reconcileTeacherStudentUsage } = require('../src/services/studentQuota.service');

function parseArgs(argv) {
  const allowed = new Set(['--apply', '--backup-confirmed']);
  const teacherArgs = argv.filter(value => value.startsWith('--teacher='));
  const flags = argv.filter(value => !value.startsWith('--teacher='));
  if (teacherArgs.length !== 1 || flags.some(value => !allowed.has(value)) || new Set(argv).size !== argv.length) {
    throw new Error('INVALID_ARGUMENTS');
  }
  const teacherId = teacherArgs[0].slice('--teacher='.length);
  if (!mongoose.isObjectIdOrHexString(teacherId)) throw new Error('INVALID_TEACHER_ID');
  const apply = flags.includes('--apply');
  const backupConfirmed = flags.includes('--backup-confirmed');
  if (apply && !backupConfirmed) throw new Error('BACKUP_CONFIRMATION_REQUIRED');
  return { teacherId, apply, backupConfirmed };
}

async function main() {
  require('dotenv').config({ quiet: true });
  try {
    const options = parseArgs(process.argv.slice(2));
    console.log(options.apply ? 'MODE=APPLY' : 'MODE=DRY_RUN');
    if (options.apply) console.log('BACKUP_CONFIRMED=true');
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI_MISSING');
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000 });
    console.log(JSON.stringify(await reconcileTeacherStudentUsage(options.teacherId, { apply: options.apply }), null, 2));
  } catch (error) {
    console.error(`FAIL ${/^[A-Z_]+$/.test(error.message) ? error.message : 'STUDENT_USAGE_RECONCILIATION_FAILED'}`);
    process.exitCode = 1;
  } finally { await mongoose.disconnect(); }
}

if (require.main === module) main();
module.exports = { parseArgs };
