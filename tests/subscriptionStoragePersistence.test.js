'use strict';
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const User = require('../src/models/user.model');
const Plan = require('../src/models/Plan');
const File = require('../src/models/File');
const { assignPlanToUser } = require('../src/middlewares/usage.middleware');
const { calculateOwnedStorageUsage, buildStorageContract } = require('../src/services/ownedStorage.service');

beforeAll(connectInMemoryMongo);afterAll(disconnectInMemoryMongo);beforeEach(clearDatabase);
test('plan and billing-period changes preserve authoritative owned storage bytes',async()=>{
  const [free,essentialMonthly,essentialAnnual,pro]=await Plan.create([
    {name:'Free',slug:'free',isActive:true,features:{storageMB:500}},
    {name:'Essential Monthly',slug:'essential-monthly',isActive:true,features:{storageMB:2048}},
    {name:'Essential Annual',slug:'essential-annual',isActive:true,features:{storageMB:2048}},
    {name:'Pro',slug:'pro',isActive:true,features:{storageMB:5120}}
  ]);
  const teacher=await User.create({firebaseUid:'storage-teacher',email:'storage@example.test',role:'teacher',plan:free._id,usage:{storageMB:999}});
  const bytes=2359296;
  await File.create({originalName:'owned.docx',filename:'owned.docx',path:'missing-legacy-path.docx',url:'/owned.docx',uploadedBy:teacher._id,role:'teacher',type:'assignments',sizeBytes:bytes});
  for(const plan of [essentialMonthly,essentialAnnual,pro,free]){await assignPlanToUser(teacher,plan,new Date());const owned=await calculateOwnedStorageUsage(teacher._id);expect(owned.usedBytes).toBe(bytes);expect(buildStorageContract(owned.usedBytes,plan).usedBytes).toBe(bytes)}
  expect(buildStorageContract(bytes,essentialAnnual)).toMatchObject({usedBytes:bytes,limitBytes:2048*1024*1024,percent:0.11});
  expect((await User.findById(teacher._id)).usage.storageMB).toBe(999);
});

test('legacy counters cannot override unique File accounting',async()=>{
  const plan={features:{storageMB:500}};expect(buildStorageContract(2359296,plan)).toMatchObject({usedBytes:2359296,limitBytes:500*1024*1024,percent:0.45});
});
