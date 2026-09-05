'use strict';
const {connectInMemoryMongo,disconnectInMemoryMongo,clearDatabase}=require('./helpers/testServer');
const Plan=require('../src/models/Plan');const CreditPack=require('../src/models/CreditPack');const Topup=require('../src/services/topup.service');
const {PACKS,seedAssessmentCreditPacks}=require('../scripts/seedAssessmentCreditPacks');
beforeAll(connectInMemoryMongo);afterAll(disconnectInMemoryMongo);beforeEach(clearDatabase);
test('provisions exactly the two authoritative purchasable packs and hides inactive packs',async()=>{
 await Plan.create({name:'Essential',slug:'essential',isActive:true,features:{essayAnalysesPerMonth:100}});
 await CreditPack.create({name:'Legacy',code:'TOPUP_SMALL',credits:5,price:9.99,currency:'USD',allowedPlans:['essential'],active:true});
 await seedAssessmentCreditPacks();const catalog=await Topup.listPacks();
 expect(catalog.map(x=>x.code)).toEqual(['CREDITS_10','CREDITS_50']);expect(catalog.map(x=>({credits:x.credits,price:x.price,currency:x.currency}))).toEqual([
  {credits:10,price:1.99,currency:'USD'},{credits:50,price:4.99,currency:'USD'}]);expect((await CreditPack.findOne({code:'TOPUP_SMALL'})).active).toBe(false);
 expect(PACKS).toHaveLength(2);
});
test('PayPal eligibility needs no provider subscription plan or Stripe price ID',async()=>{await Plan.create({name:'Free',slug:'free',isActive:true});await seedAssessmentCreditPacks();
 const pack=await CreditPack.findOne({code:'CREDITS_10'});expect(pack.stripePriceId).toBeNull();expect(pack.toObject()).not.toHaveProperty('paypalPlanId');});
