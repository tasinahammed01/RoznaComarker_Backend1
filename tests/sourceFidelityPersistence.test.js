'use strict';
process.env.NODE_ENV='test';
const mongoose=require('mongoose');
const Submission=require('../src/models/Submission');
const Snapshot=require('../src/models/SourceFidelitySnapshot');
const {connectInMemoryMongo,disconnectInMemoryMongo}=require('./helpers/testServer');
const sf=require('../src/utils/sourceFidelity');
beforeAll(async()=>{await connectInMemoryMongo();await Snapshot.init();});
afterAll(disconnectInMemoryMongo);
test('GPT source and active offsets survive Mongo, immutable receipt and normal frontend serialization',async()=>{
  const value=data('  Society always expect\npowerfull Say , wrong wrong  ');
  Object.assign(value.ocrPages[0],{sourceFidelityMode:'gpt_vision_exact',sourceFidelityVersion:'gpt-vision-exact-v1',sourceFidelityStatus:'GPT_SOURCE_ACCEPTED',
    words:[{id:'word_f_1_gpt_1',text:'Society',sourceStart:2,sourceEnd:9,bbox:null}]});
  value.sourceFidelityMode='gpt_vision_exact';Object.assign(value,sf.aggregate(value));
  const d=await Submission.create(value),saved=await Submission.findById(d._id);
  expect(sf.eligible(saved)).toBe(true);expect(sf.canonical(saved).text).toBe(value.sourceTranscriptExact);
  expect(saved.ocrPages[0].words[0]).toMatchObject({sourceStart:2,bbox:null});expect(saved.toJSON().sourceFidelity).toBeUndefined();
  await expect(Submission.updateOne({_id:d._id},{$set:{sourceTranscriptExact:'normalized'}})).rejects.toThrow();
});
const data=(text,identity='pixels')=>{const file=new mongoose.Types.ObjectId();const d={student:new mongoose.Types.ObjectId(),
  assignment:new mongoose.Types.ObjectId(),class:new mongoose.Types.ObjectId(),files:[file],ocrJobId:'job',status:'submitted',submittedAt:new Date(),
  ocrPages:[{fileId:file,fileOrder:0,pageNumber:1,pageIndex:0,sourceTextExact:text,sourceTextSha256:sf.sha(text),
    sourceInputSha256:sf.sha(identity),sourceFidelityVersion:sf.VERSION,sourceFidelityMode:'astra_verified',sourceFidelityStatus:'MODEL_AGREED'}]};
  return {...d,...sf.aggregate(d)};};
test('Mongo roundtrip and API serialization preserve exact characters, no trim setters',async()=>{
  const text='  sence \nSocial ,free\n';const d=await Submission.create(data(text));const saved=await Submission.findById(d._id);
  expect(saved.sourceTranscriptExact).toBe(text);expect(saved.ocrPages[0].sourceTextExact).toBe(text);
  expect(saved.toJSON().sourceFidelity.transcriptExact).toBe(text);
  expect(sf.canonical(saved).text).toBe(text);
});
test('same-identity top level/page mutation rejected by query and document paths',async()=>{
  const d=await Submission.create(data('sence'));
  await expect(Submission.updateOne({_id:d._id},{$set:{sourceTranscriptExact:'sense'}})).rejects.toThrow();
  await expect(Submission.updateOne({_id:d._id},{$set:{'ocrPages.0.sourceTextExact':'sense'}})).rejects.toThrow();
  await expect(Submission.updateOne({_id:d._id},{$push:{ocrPages:{sourceTextExact:'sense'}}})).rejects.toThrow('OPERATOR_MUTATION');
  d.sourceTranscriptExact='sense';d.sourceTranscriptSha256=sf.sha('sense');d.ocrPages[0].sourceTextExact='sense';d.ocrPages[0].sourceTextSha256=sf.sha('sense');
  await expect(d.save()).rejects.toThrow('IDENTITY_MUTATION');
});
test('new source identity permits legitimate resubmission, old receipt remains protected',async()=>{
  const d=await Submission.create(data('sence'));
  const next=data('sense','newpixels');await Submission.updateOne({_id:d._id},{$set:{...next,ocrJobId:'newjob'}});
  expect((await Submission.findById(d._id)).sourceTranscriptExact).toBe('sense');
});
test('manual alias edits cannot redefine exact canonical input',async()=>{
  const d=await Submission.create(data('sence'));
  d.transcriptText='sense';d.rawTranscriptText='sense';await d.save();
  expect(sf.canonical(await Submission.findById(d._id)).text).toBe('sence');
});
test('targeted V2 metadata survives Mongo while private provider evidence stays out of public summary',async()=>{
  const value=data('sence');Object.assign(value.ocrPages[0],{sourceFidelityVersion:'targeted-source-v2',sourceVerificationStage:'OCR_UNCERTAIN',
    sourceVerificationSummary:{candidateRegionCount:1,unresolvedTargetedCount:1,candidateReasons:['POSSIBLE_READER_OMISSION']}});
  Object.assign(value,sf.aggregate(value));const d=await Submission.create(value),saved=await Submission.findById(d._id);
  expect(saved.sourceFidelityVersion).toBe('targeted-source-v2');expect(saved.ocrPages[0].sourceVerificationStage).toBe('OCR_UNCERTAIN');
  expect(saved.toJSON().sourceFidelity.pages[0]).toMatchObject({candidateCount:1,unresolvedCandidateCount:1});expect(sf.eligible(saved)).toBe(false);
});
