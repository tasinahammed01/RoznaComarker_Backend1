'use strict';
const {connectInMemoryMongo,disconnectInMemoryMongo,clearDatabase}=require('./helpers/testServer');
const Plan=require('../src/models/Plan');const CreditPack=require('../src/models/CreditPack');const User=require('../src/models/user.model');const Topup=require('../src/services/topup.service');
const {seedAssessmentCreditPacks}=require('../scripts/seedAssessmentCreditPacks');
beforeAll(connectInMemoryMongo);afterAll(disconnectInMemoryMongo);beforeEach(clearDatabase);
test('requires explicit commercial values and never deactivates or reprices existing packs',async()=>{
 await Plan.create({name:'Free',slug:'free',isActive:true,features:{essayAnalysesPerMonth:25}});
 const user=await User.create({firebaseUid:'catalog',email:'catalog@example.com',role:'teacher'});
 await expect(seedAssessmentCreditPacks()).rejects.toThrow('approved catalog');
 const approved=[{name:'Ten',code:'APPROVED_10',credits:10,price:3.25,currency:'USD',allowedPlans:['free'],active:true,displayOrder:1}];
 await seedAssessmentCreditPacks(approved);await seedAssessmentCreditPacks([{...approved[0],price:8}]);
 expect((await Topup.listPacks(user))[0].price).toBe(3.25);
 await CreditPack.updateOne({code:'APPROVED_10'},{$set:{active:false}});
 expect(await Topup.listPacks(user)).toEqual([]);
});
test('PayPal packs need no subscription plan ID or historical Stripe price',async()=>{
 const pack=await CreditPack.create({name:'Ten',code:'APPROVED_10',credits:10,price:3.25,currency:'USD',allowedPlans:['free'],active:true,displayOrder:1});
 expect(pack.stripePriceId).toBeNull();expect(pack.toObject()).not.toHaveProperty('paypalPlanId');
});
