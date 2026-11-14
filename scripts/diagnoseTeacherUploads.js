'use strict';
// READ-ONLY diagnostic for one assignment's submissions (FIX 2 / FIX 3): why work is or is not listed for the teacher, and where
// its marking stands. Prints ids, statuses, counts, ages and error codes only: never names, emails, essay or OCR text, provider
// details, lease owner names or connection details. It only runs find/count queries; it never writes.
//
//   node scripts/diagnoseTeacherUploads.js <assignmentId>            (reads MONGO_URI from the environment / backend .env)
//   node scripts/diagnoseTeacherUploads.js <assignmentId> --json     (one JSON document instead of the table)
const path = require('path');
const crypto = require('crypto');
const { ObjectId } = require('mongoose').mongo;
const { dueWorkQuery, workerConfig } = require('../src/services/assessmentRecovery.service');
const { statusOf, failureCodeOf } = require('../src/services/teacherUpload.service');
const { available: walletAvailable } = require('../src/services/credit.service');

const short = value => (value ? crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 8) : null);
const ageSeconds = (date, now) => (date ? Math.round((now - new Date(date)) / 1000) : null);
const code = value => (value == null ? null : String(value).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 64));

async function diagnose(db, assignmentId, now = new Date()) {
  if (!ObjectId.isValid(String(assignmentId))) throw Object.assign(new Error('Pass a valid assignment id.'), { code: 'BAD_ID' });
  const config = workerConfig();
  const assignment = await db.collection('assignments').findOne({ _id: new ObjectId(String(assignmentId)) },
    { projection: { _id: 1, class: 1, teacher: 1, isActive: 1, resourceType: 1, allowGuestSubmission: 1, deadline: 1 } });
  if (!assignment) return { assignmentId: String(assignmentId), found: false };
  const classDoc = await db.collection('classes').findOne({ _id: assignment.class },
    { projection: { _id: 1, teacher: 1, isActive: 1, status: 1, institutionId: 1 } });
  const wallet = await db.collection('creditwallets').findOne({ userId: assignment.teacher });
  const reserved = await db.collection('submissions').countDocuments({ 'teacherUpload.uploadedBy': assignment.teacher, assessmentStatus: { $in: ['started', 'processing'] } });

  const submissions = await db.collection('submissions').find({ assignment: assignment._id }, { projection: {
    _id: 1, class: 1, submissionMode: 1, student: 1, status: 1, submittedAt: 1, createdAt: 1, updatedAt: 1, files: 1,
    'teacherUpload.uploadedBy': 1, 'teacherUpload.uploadedAt': 1, 'teacherUpload.batchId': 1, 'teacherUpload.email.status': 1, 'teacherUpload.email.lastErrorCode': 1,
    ocrStatus: 1, ocrJobId: 1, ocrErrorCode: 1, 'ocrFailures.code': 1, 'ocrFailures.retryable': 1, ocrUpdatedAt: 1,
    correctionStatus: 1, semanticStatus: 1, semanticErrorCode: 1, evaluationStatus: 1, evaluationErrorCode: 1,
    assessmentStatus: 1, assessmentErrorCode: 1, analysisLeaseOwner: 1, analysisLeaseExpiresAt: 1, analysisAttempt: 1,
    analysisNextRetryAt: 1, analysisErrorCode: 1 } }).sort({ createdAt: 1 }).toArray();

  const rows = [];
  for (const doc of submissions) {
    const upload = doc.teacherUpload?.uploadedBy ? doc.teacherUpload : null;
    const due = await db.collection('submissions').countDocuments({ _id: doc._id, ...dueWorkQuery(now, config.maxAttempts, config.leaseMs) });
    const leaseLive = !!(doc.analysisLeaseExpiresAt && new Date(doc.analysisLeaseExpiresAt) > now);
    rows.push({
      submissionId: String(doc._id),
      mode: doc.submissionMode || 'registered',
      teacherUpload: !!upload,
      batch: upload ? short(upload.batchId) : null,
      // The teacher's lists: every list for the assignment matches on assignment + the assignment's class; the upload-status
      // list additionally needs the uploader to be this assignment's teacher.
      listedForTeacher: String(doc.class) === String(assignment.class),
      inUploadStatusList: !!upload && String(upload.uploadedBy) === String(assignment.teacher) && String(doc.class) === String(assignment.class),
      teacherStatus: upload ? statusOf(doc) : null,
      teacherFailureCode: upload ? failureCodeOf(doc) : null,
      pages: Array.isArray(doc.files) ? doc.files.length : 0,
      status: doc.status || null,
      ocr: { status: doc.ocrStatus || null, jobId: doc.ocrJobId ? 'present' : 'missing', errorCode: code(doc.ocrErrorCode),
        failures: (doc.ocrFailures || []).map(f => `${code(f?.code)}${f?.retryable ? ':retryable' : ':permanent'}`), updatedAgeS: ageSeconds(doc.ocrUpdatedAt, now) },
      correction: doc.correctionStatus || null,
      semantic: { status: doc.semanticStatus || null, errorCode: code(doc.semanticErrorCode) },
      evaluation: { status: doc.evaluationStatus || null, errorCode: code(doc.evaluationErrorCode) },
      assessment: { status: doc.assessmentStatus || null, errorCode: code(doc.assessmentErrorCode) },
      lease: { owner: short(doc.analysisLeaseOwner), live: leaseLive, expiresInS: doc.analysisLeaseExpiresAt ? -ageSeconds(doc.analysisLeaseExpiresAt, now) : null },
      attempts: { used: Number(doc.analysisAttempt || 0), max: config.maxAttempts, nextRetryInS: doc.analysisNextRetryAt ? -ageSeconds(doc.analysisNextRetryAt, now) : null,
        lastErrorCode: code(doc.analysisErrorCode) },
      workerWillPickUp: due === 1,
      quietForS: ageSeconds(doc.updatedAt, now),
      email: upload ? { status: upload.email?.status || 'none', lastErrorCode: code(upload.email?.lastErrorCode) } : null,
    });
  }
  return {
    assignmentId: String(assignment._id), found: true, generatedAt: now.toISOString(),
    assignment: { active: assignment.isActive !== false, resourceType: assignment.resourceType || 'essay', guestSubmissionsAllowed: assignment.allowGuestSubmission === true,
      duePassed: assignment.deadline ? new Date(assignment.deadline) < now : null },
    class: classDoc ? { active: classDoc.isActive !== false, status: classDoc.status || null, sameTeacher: String(classDoc.teacher) === String(assignment.teacher),
      institution: !!classDoc.institutionId } : null,
    credits: { personalWallet: wallet ? walletAvailable(wallet) : null, reservedByUnfinishedUploads: reserved,
      note: classDoc?.institutionId ? 'institution class: credits come from the institution pool (not shown)' : undefined },
    worker: { maxAttempts: config.maxAttempts, leaseS: Math.round(config.leaseMs / 1000) },
    totals: { submissions: rows.length, teacherUploads: rows.filter(r => r.teacherUpload).length,
      byTeacherStatus: rows.filter(r => r.teacherUpload).reduce((acc, r) => ({ ...acc, [r.teacherStatus]: (acc[r.teacherStatus] || 0) + 1 }), {}) },
    submissions: rows,
  };
}

function printTable(report) {
  if (!report.found) { console.log(`assignment ${report.assignmentId}: not found`); return; }
  console.log(JSON.stringify({ assignment: report.assignment, class: report.class, credits: report.credits, worker: report.worker, totals: report.totals }, null, 2));
  for (const r of report.submissions) {
    console.log([r.submissionId, r.mode, r.teacherUpload ? 'upload' : 'student', `listed=${r.listedForTeacher}`, `teacher=${r.teacherStatus ?? '-'}${r.teacherFailureCode ? '(' + r.teacherFailureCode + ')' : ''}`,
      `ocr=${r.ocr.status}${r.ocr.errorCode ? '(' + r.ocr.errorCode + ')' : ''}`, `corr=${r.correction}`, `sem=${r.semantic.status}`, `eval=${r.evaluation.status}${r.evaluation.errorCode ? '(' + r.evaluation.errorCode + ')' : ''}`,
      `assess=${r.assessment.status}${r.assessment.errorCode ? '(' + r.assessment.errorCode + ')' : ''}`, `lease=${r.lease.owner ?? '-'}${r.lease.live ? ':live' : ''}`,
      `attempts=${r.attempts.used}/${r.attempts.max}`, `due=${r.workerWillPickUp}`, `quiet=${r.quietForS}s`, `email=${r.email?.status ?? '-'}`].join('  '));
  }
}

async function main() {
  const [assignmentId] = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
  if (!assignmentId) { console.error('Usage: node scripts/diagnoseTeacherUploads.js <assignmentId> [--json]'); process.exit(2); }
  require('dotenv').config({ path: path.join(__dirname, '../.env'), quiet: true });
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not configured');
  const { MongoClient } = require('mongoose').mongo;
  const client = new MongoClient(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000, maxPoolSize: 2, readPreference: 'secondaryPreferred' });
  try {
    await client.connect();
    const report = await diagnose(client.db(), assignmentId);
    if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2)); else printTable(report);
  } finally { await client.close(); }
}

if (require.main === module) main().catch(error => {
  // Driver errors may contain connection details: print the code only.
  console.error(`diagnoseTeacherUploads failed: ${error?.code || error?.codeName || 'ERROR'}`);
  process.exit(1);
});

module.exports = { diagnose };
