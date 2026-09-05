'use strict'; process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'semester-copy-test'; process.env.FRONTEND_URL = 'http://localhost:4200';
jest.mock('../src/services/ocrPipeline.service', () => ({ runOcrAndPersist: jest.fn(), runOcrAndPersistForFiles: jest.fn() }));
jest.mock('../src/services/autoRubricDesigner.service', () => ({ autoGenerateRubricDesignerForSubmission: jest.fn() }));
const request = require('supertest'); const app = require('../src/app'); const User = require('../src/models/user.model');
const Class = require('../src/models/class.model'); const Assignment = require('../src/models/assignment.model');
const Membership = require('../src/models/membership.model'); const Submission = require('../src/models/Submission');
const FlashcardSet = require('../src/models/FlashcardSet'); const Worksheet = require('../src/models/Worksheet');
const Notification = require('../src/models/notification.model'); const CreditTransaction = require('../src/models/CreditTransaction');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer'); const { signTestJwt } = require('./helpers/auth');
const { seedTestPlans } = require('./helpers/seedTestPlans');

describe('copy previous semester', () => {
  let teacher; let foreign; let source; let token; let essay; let flash; let worksheetAssignment;
  beforeAll(connectInMemoryMongo); afterAll(disconnectInMemoryMongo);
  beforeEach(async () => { await clearDatabase(); await seedTestPlans(); teacher = await User.create({ firebaseUid: 'copy-t', email: 'copy-t@test.dev', role: 'teacher' });
    foreign = await User.create({ firebaseUid: 'copy-f', email: 'copy-f@test.dev', role: 'teacher' }); token = signTestJwt({ id: teacher._id, firebaseUid: teacher.firebaseUid, role: 'teacher' });
    source = await Class.create({ name: 'Old Semester', description: 'Reusable details', subjectLevel: 'Grade 8', teacher: teacher._id, joinCode: 'OLDCODE', status: 'archived', isActive: true });
    const fc = await FlashcardSet.create({ title: 'Words', ownerId: teacher._id, cards: [{ front: 'a', back: 'b' }] });
    const ws = await Worksheet.create({ title: 'Sheet', assignmentDeadline: new Date(), createdBy: teacher._id });
    const base = { deadline: new Date('2025-01-01'), class: source._id, teacher: teacher._id, allowResubmission: true, requireAdaptiveBeforeResubmission: true };
    essay = await Assignment.create({ ...base, title: 'Essay', resourceType: 'essay', rubric: '{"one":1}', rubrics: { totalPoints: 10, criteria: [] }, qrToken: 'old-essay' });
    flash = await Assignment.create({ ...base, title: 'Cards', resourceType: 'flashcard', resourceId: String(fc._id), qrToken: 'old-flash' });
    worksheetAssignment = await Assignment.create({ ...base, title: 'Worksheet', resourceType: 'worksheet', resourceId: String(ws._id), qrToken: 'old-sheet' });
  });
  const auth = (call) => call.set('Authorization', `Bearer ${token}`);
  test('previews owned archived classes without runtime data and rejects foreign classes', async () => {
    const preview = await auth(request(app).get(`/api/classes/${source._id}/copy-preview`)); expect(preview.status).toBe(200);
    expect(preview.body.data.assignments).toHaveLength(3); expect(preview.body.data).not.toHaveProperty('memberships');
    const other = await Class.create({ name: 'Other', teacher: foreign._id, joinCode: 'OTHERCPY' });
    expect((await auth(request(app).get(`/api/classes/${other._id}/copy-preview`))).status).toBe(404);
  });
  test('creates one clean active class with selected independent configuration and reusable resource references', async () => {
    const before = await Class.findById(source._id).lean(); const credits = await CreditTransaction.countDocuments();
    const payload = { requestId: 'copy-request-123', newClass: { name: 'New Semester' }, assignmentIds: [String(essay._id), String(flash._id), String(worksheetAssignment._id)], deadlineMode: 'unset' };
    const response = await auth(request(app).post(`/api/classes/${source._id}/copy-semester`).send(payload)); expect(response.status).toBe(200);
    const target = response.body.data.class; expect(target._id).not.toBe(String(source._id)); expect(target.joinCode).not.toBe(source.joinCode); expect(target.status).toBe('active');
    const copied = await Assignment.find({ class: target._id }).lean(); expect(copied).toHaveLength(3);
    expect(copied.every((x) => !x.deadline && x.qrToken && !['old-essay','old-flash','old-sheet'].includes(x.qrToken))).toBe(true);
    expect(copied.find((x) => x.resourceType === 'flashcard').resourceId).toBe(flash.resourceId);
    expect(copied.find((x) => x.resourceType === 'worksheet').resourceId).toBe(worksheetAssignment.resourceId);
    expect(copied.filter((x)=>x.resourceType!=='essay').every((x)=>x.allowResubmission===false&&x.requireAdaptiveBeforeResubmission===false)).toBe(true);
    expect(copied.find((x) => x.resourceType === 'essay').rubrics).toEqual(expect.objectContaining({ totalPoints: 10 }));
    expect(await Membership.countDocuments({ class: target._id })).toBe(0); expect(await Submission.countDocuments({ class: target._id })).toBe(0);
    expect(await Notification.countDocuments({ 'data.classId': String(target._id) })).toBe(0); expect(await CreditTransaction.countDocuments()).toBe(credits);
    expect(await Class.findById(source._id).lean()).toMatchObject(before);
  });
  test('copies only selected assignments and rejects injected assignments', async () => {
    const ok = await auth(request(app).post(`/api/classes/${source._id}/copy-semester`).send({ requestId: 'selected-only-1', newClass: { name: 'Selected' }, assignmentIds: [String(essay._id)], deadlineMode: 'unset' }));
    expect(await Assignment.countDocuments({ class: ok.body.data.class._id })).toBe(1);
    const outsideClass = await Class.create({ name: 'Outside', teacher: teacher._id, joinCode: 'OUTSIDEC' });
    const outside = await Assignment.create({ title: 'Outside', deadline: new Date(), class: outsideClass._id, teacher: teacher._id });
    const bad = await auth(request(app).post(`/api/classes/${source._id}/copy-semester`).send({ requestId: 'injected-id-1', newClass: { name: 'Bad' }, assignmentIds: [String(outside._id)], deadlineMode: 'unset' }));
    expect(bad.status).toBe(400); expect(await Class.countDocuments({ name: 'Bad' })).toBe(0);
  });
  test('edits copied Flashcard and Worksheet deadlines on the same assignments without touching resources or other classes', async () => {
    const anotherClass=await Class.create({name:'Other Semester',teacher:teacher._id,joinCode:'OTHERSEM'});
    const another=await Assignment.create({title:'Other Cards',resourceType:'flashcard',resourceId:flash.resourceId,deadline:new Date('2027-01-10'),class:anotherClass._id,teacher:teacher._id});
    const response=await auth(request(app).post(`/api/classes/${source._id}/copy-semester`).send({requestId:'edit-copied-1',newClass:{name:'Editable Semester'},assignmentIds:[String(flash._id),String(worksheetAssignment._id)],deadlineMode:'unset'}));
    const targetId=response.body.data.class._id,copied=await Assignment.find({class:targetId}).sort({resourceType:1}).lean();
    const flashcardBefore=await FlashcardSet.findById(flash.resourceId).lean(),worksheetBefore=await Worksheet.findById(worksheetAssignment.resourceId).lean();
    expect(copied).toHaveLength(2);expect(copied.every(item=>item.deadline==null)).toBe(true);
    const deadline='2027-02-18T23:59:59.999Z';
    for(const assignment of copied){const edited=await auth(request(app).patch(`/api/assignments/${assignment._id}`).send({deadline,allowResubmission:true,requireAdaptiveBeforeResubmission:true}));expect(edited.status).toBe(200);expect(edited.body.data._id).toBe(String(assignment._id));expect(edited.body.data.allowResubmission).toBe(false);expect(edited.body.data.requireAdaptiveBeforeResubmission).toBe(false);}
    const after=await Assignment.find({class:targetId}).lean();expect(after).toHaveLength(2);expect(after.every(item=>item.deadline.toISOString()===deadline)).toBe(true);
    expect((await Assignment.findById(flash._id).lean()).deadline.toISOString()).toBe('2025-01-01T00:00:00.000Z');
    expect((await Assignment.findById(worksheetAssignment._id).lean()).deadline.toISOString()).toBe('2025-01-01T00:00:00.000Z');
    expect((await Assignment.findById(another._id).lean()).deadline.toISOString()).toBe('2027-01-10T00:00:00.000Z');
    expect(await FlashcardSet.findById(flash.resourceId).lean()).toMatchObject(flashcardBefore);
    expect(await Worksheet.findById(worksheetAssignment.resourceId).lean()).toMatchObject(worksheetBefore);
  });
  test('concurrent replay returns one target class', async () => {
    const payload = { requestId: 'double-click-1', newClass: { name: 'Once' }, assignmentIds: [String(essay._id)], deadlineMode: 'unset' };
    const results = await Promise.all([1, 2].map(() => auth(request(app).post(`/api/classes/${source._id}/copy-semester`).send(payload))));
    expect(results.every((x) => x.status === 200)).toBe(true); expect(new Set(results.map((x) => x.body.data.class._id)).size).toBe(1); expect(await Class.countDocuments({ name: 'Once' })).toBe(1);
  });
});
