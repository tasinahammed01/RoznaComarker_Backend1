'use strict';
process.env.NODE_ENV='test';process.env.JWT_SECRET='guest-disabled-test-secret';
jest.mock('../src/services/email.service',()=>({sendGuestSubmissionEmail:jest.fn()}));
jest.mock('../src/services/assessmentRecovery.service',()=>({scheduleSubmissionAnalysis:jest.fn()}));
jest.mock('../src/services/imagePreflight.service',()=>({evaluateImage:jest.fn()}));
const request=require('supertest'),app=require('../src/app');
const Submission=require('../src/models/Submission');
const {guestSubmissionEnabled}=require('../src/config/guestSubmission');
const email=require('../src/services/email.service'),analysis=require('../src/services/assessmentRecovery.service'),preflight=require('../src/services/imagePreflight.service');
describe('guest global kill switch fails closed before any guest work',()=>{
 beforeEach(()=>{process.env.GUEST_SUBMISSION_ENABLED='false';jest.clearAllMocks();});
 afterEach(()=>jest.restoreAllMocks());
 test.each([undefined,'false','','TRUE','1','yes',' false ','true '])('configuration %s remains disabled',value=>{if(value===undefined)delete process.env.GUEST_SUBMISSION_ENABLED;else process.env.GUEST_SUBMISSION_ENABLED=value;expect(guestSubmissionEnabled()).toBe(false);});
 test('explicit true reversibly enables the guard',()=>{process.env.GUEST_SUBMISSION_ENABLED='true';expect(guestSubmissionEnabled()).toBe(true);});
 test('teacher create cannot opt in through a stale payload while globally disabled',async()=>{
  const json=jest.fn(),res={status:jest.fn().mockReturnThis(),json};
  await require('../src/controllers/assignment.controller').createAssignment({body:{title:'Guest essay',writingType:'Narrative',classId:'507f1f77bcf86cd799439011',deadline:'2099-08-11',allowGuestSubmission:true},user:{_id:'507f1f77bcf86cd799439012'}},res);
  expect(res.status).toHaveBeenCalledWith(403);expect(json).toHaveBeenCalledWith(expect.objectContaining({message:'Guest submission is temporarily unavailable.'}));
 });
 const id='507f1f77bcf86cd799439011';
 test.each([['get','/assignments/old-saved-token'],['post','/assignments/old-saved-token/submit'],['post','/assignments/old-saved-token/recover'],['get',`/submissions/${id}`],['get',`/submissions/${id}/pdf`],['get',`/submissions/${id}/ocr-corrections`],['get',`/submissions/${id}/practice`],['post',`/submissions/${id}/practice`],['post',`/submissions/${id}/practice/session/activity`],['get',`/submissions/${id}/drafts`]])('%s %s is blocked before lookup, creation, providers or email',async(method,path)=>{
  const create=jest.spyOn(Submission,'create'),lookup=jest.spyOn(Submission,'findOne');
  const res=await request(app)[method]('/api/guest'+path).set('X-Guest-Token','saved-token').send({name:'Guest',email:'guest@example.test'});
  expect(res.status).toBe(403);expect(res.body.code).toBe('GUEST_SUBMISSION_UNAVAILABLE');expect(res.headers['cache-control']).toBe('no-store');
  expect(create).not.toHaveBeenCalled();expect(lookup).not.toHaveBeenCalled();expect(email.sendGuestSubmissionEmail).not.toHaveBeenCalled();expect(analysis.scheduleSubmissionAnalysis).not.toHaveBeenCalled();expect(preflight.evaluateImage).not.toHaveBeenCalled();
 });
 test('multipart uploads are denied before storage/preflight',async()=>{const res=await request(app).post('/api/guest/assignments/old/submit').field('name','Guest').attach('files',Buffer.from('not-an-image'),'file.png');expect(res.status).toBe(403);expect(preflight.evaluateImage).not.toHaveBeenCalled();});
 test('status exposes only availability and never caches it',async()=>{let res=await request(app).get('/api/guest/status');expect(res.body).toEqual({success:true,data:{enabled:false}});process.env.GUEST_SUBMISSION_ENABLED='true';res=await request(app).get('/api/guest/status');expect(res.body.data.enabled).toBe(true);expect(res.headers['cache-control']).toBe('no-store');});
});
