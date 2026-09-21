'use strict';

const mongoose = require('mongoose');
const { parseArgs: parseDiagnosticArgs } = require('../scripts/diagnoseStudentUsage');
const { parseArgs } = require('../scripts/reconcileStudentUsage');

describe('student usage maintenance CLI', () => {
  const teacherId = new mongoose.Types.ObjectId().toString();

  test('diagnostic requires one valid teacher and optionally scopes an affected class', () => {
    const classId = new mongoose.Types.ObjectId().toString();
    expect(parseDiagnosticArgs([`--teacher=${teacherId}`])).toEqual({ teacherId, classId: null });
    expect(parseDiagnosticArgs([`--teacher=${teacherId}`, `--class=${classId}`])).toEqual({ teacherId, classId });
    expect(() => parseDiagnosticArgs([])).toThrow('INVALID_ARGUMENTS');
    expect(() => parseDiagnosticArgs(['--teacher=not-an-id'])).toThrow('INVALID_TEACHER_ID');
    expect(() => parseDiagnosticArgs([`--teacher=${teacherId}`, '--class=bad'])).toThrow('INVALID_CLASS_ID');
  });

  test('reconciliation defaults to dry-run and backup confirmation alone cannot apply', () => {
    expect(parseArgs([`--teacher=${teacherId}`])).toEqual({ teacherId, apply: false, backupConfirmed: false });
    expect(parseArgs([`--teacher=${teacherId}`, '--backup-confirmed']))
      .toEqual({ teacherId, apply: false, backupConfirmed: true });
  });

  test('apply requires backup confirmation and unknown arguments fail', () => {
    expect(() => parseArgs([`--teacher=${teacherId}`, '--apply'])).toThrow('BACKUP_CONFIRMATION_REQUIRED');
    expect(() => parseArgs([`--teacher=${teacherId}`, '--apply', '--unknown'])).toThrow('INVALID_ARGUMENTS');
    expect(parseArgs([`--teacher=${teacherId}`, '--apply', '--backup-confirmed']))
      .toEqual({ teacherId, apply: true, backupConfirmed: true });
  });
});
