'use strict';
process.env.NODE_ENV = 'test'; process.env.PAYMENT_PROVIDER = 'paypal'; process.env.PAYPAL_ENV = 'sandbox';
process.env.FRONTEND_URL = 'http://localhost:4200';
process.env.JWT_SECRET = 'billing-in-memory-test-secret-not-for-production';
process.env.GCE_METADATA_DISABLED = 'true';
require('./helpers/phase1Setup');
const crypto = require('crypto');
const mongoose = require('mongoose');
const request = require('supertest');
const app = require('../src/app');
const { signTestJwt } = require('./helpers/auth');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const Plan = require('../src/models/Plan');
const User = require('../src/models/user.model');
const Entitlement = require('../src/models/PlanEntitlement');
const Attempt = require('../src/models/PaymentPurchaseAttempt');
const Promo = require('../src/models/PromoCode');
const Usage = require('../src/models/PromoUsage');
const Wallet = require('../src/models/CreditWallet');
const Audit = require('../src/models/AdminAuditLog');
const Billing = require('../src/services/planBilling.service');
const Promos = require('../src/services/promoCode.service');
const Money = require('../src/services/billingMoney.service');
const Purchase = require('../src/services/paypal/paypalPlanPurchase.service');
const Terms = require('../src/services/planEntitlement.service');
jest.setTimeout(60000);
let free, essential, pro, user, admin;
const promoInput = (overrides = {}) => ({ code: 'SAVE20', active: true, discountType: 'PERCENT', discountValue: '20',
  currency: 'USD', plans: [], billingPeriods: [], totalLimit: null, perUserLimit: null, ...overrides });
const createPromo = overrides => Billing.transaction(session => Promos.save(promoInput(overrides), admin._id, null, session));
const token = account => signTestJwt({ id: account._id, firebaseUid: account.firebaseUid, role: account.role });
const quote = (overrides = {}) => Billing.createQuote({ userId: user._id, planSlug: 'pro', billingPeriod: 'monthly', ...overrides });
function provider(attemptId, value = '20.00', currency = 'USD') {
  const orderId = `ORDER-${attemptId}`, captureId = `CAP-${attemptId}`;
  const order = { id: orderId, status: 'COMPLETED', purchase_units: [{ reference_id: attemptId,
    custom_id: `paypal-plan:${attemptId}`, amount: { value, currency_code: currency },
    payments: { captures: [{ id: captureId, status: 'COMPLETED', amount: { value, currency_code: currency } }] } }] };
  return { order, createOrder: jest.fn().mockResolvedValue({ id: orderId, links: [{ rel: 'approve', method: 'GET',
    href: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}` }] }),
    captureOrder: jest.fn().mockResolvedValue(order), getOrder: jest.fn().mockResolvedValue(order) };
}
async function prepare(q, who = user) {
  const attemptId = crypto.randomUUID(); const client = provider(attemptId, q.finalAmount);
  const created = await Purchase.createOrder({ user: who, planSlug: q.planSlug, billingPeriod: q.billingPeriod, quoteId: q.quoteId, attemptId, client });
  return { attemptId, client, created };
}
async function paidCurrent(plan = essential, startsAt = new Date('2026-09-01T00:00:00Z'), endsAt = new Date('2026-10-01T00:00:00Z'), amount = '10.00') {
  const attemptId = crypto.randomUUID();
  const payment = await Attempt.create({ userId: user._id, provider: 'paypal', providerEnvironment: 'sandbox', purpose: 'plan_purchase',
    attemptId, planSlug: plan.slug, billingPeriod: 'monthly', expectedAmount: amount, currency: 'USD', status: 'fulfilled',
    providerCaptureId: `CAP-${attemptId}`, createRequestId: attemptId, captureRequestId: attemptId });
  return Entitlement.create({ userId: user._id, planId: plan._id, planSlug: plan.slug, source: 'paypal', status: 'active',
    billingPeriod: 'monthly', startsAt, endsAt, paymentAttemptId: payment._id, providerCaptureId: payment.providerCaptureId });
}
beforeAll(async () => { await connectInMemoryMongo({ replicaSet: true }); await Promise.all([Plan, User, Entitlement, Attempt, Promo, Usage, Wallet, Audit,
  require('../src/models/BillingAccount'), require('../src/models/BillingQuote')].map(model => model.init())); });
afterAll(disconnectInMemoryMongo);
beforeEach(async () => {
  await clearDatabase();
  free = await Plan.create({ name: 'Free', slug: 'free', price: 0, currency: 'USD', features: { essayAnalysesPerMonth: 5 } });
  essential = await Plan.create({ name: 'Essential', slug: 'essential', price: 10, annualPrice: 100, currency: 'USD', features: { essayAnalysesPerMonth: 100 } });
  pro = await Plan.create({ name: 'Pro', slug: 'pro', price: 20, annualPrice: 200, currency: 'USD', features: { essayAnalysesPerMonth: 300 } });
  user = await User.create({ firebaseUid: 'teacher', email: 'teacher@example.test', role: 'teacher', plan: free._id });
  admin = await User.create({ firebaseUid: 'admin', email: 'admin@example.test', role: 'admin' });
});

describe('money and promo domain', () => {
  test.each([['0.10',10],['12.34',1234],['200',20000]])('minor unit conversion %s', (amount, cents) => { expect(Money.minor(amount)).toBe(cents); expect(Money.minor(Money.money(cents))).toBe(cents); });
  test.each(['-1','1.001','NaN','Infinity','1e3'])('rejects unsafe money %s', amount => expect(() => Money.minor(amount)).toThrow());
  test.each(['PERCENT','FIXED'])('creates %s promo and audits it', async discountType => {
    const promo = await createPromo({ discountType, discountValue: '5' }); expect(promo.discountValue).toBe('5.00'); expect(await Audit.countDocuments()).toBe(1);
  });
  test('normalized duplicate is rejected', async () => { await createPromo(); await expect(createPromo({code:' save20 '})).rejects.toMatchObject({statusCode:409}); });
  test.each([
    [{active:false},'PROMO_INVALID'],[{validFrom:'2099-01-01'},'PROMO_NOT_STARTED'],[{validUntil:'2000-01-01'},'PROMO_EXPIRED'],
    [{plans:['essential']},'PROMO_PLAN'],[{billingPeriods:['annual']},'PROMO_PERIOD'],[{currency:'EUR'},'PROMO_CURRENCY']
  ])('rejects incompatible promo %j', async (options, code) => { await createPromo(options); await expect(quote({promoCode:'save20'})).rejects.toMatchObject({code}); });
  test.each([['PERCENT','20','4.00','16.00'],['FIXED','5','5.00','15.00']])('calculates %s', async (discountType,discountValue,discountAmount,finalAmount) => {
    await createPromo({ discountType, discountValue, plans:['pro'], billingPeriods:['monthly'] });
    expect(await quote({promoCode:' Save20 '})).toMatchObject({discountAmount,finalAmount});
    expect((await Promo.findOne()).allocated).toBe(0); expect(await Usage.countDocuments()).toBe(0);
  });
  test('annual quote uses annual catalog amount',async()=>{await createPromo();expect(await quote({billingPeriod:'annual',promoCode:'SAVE20'})).toMatchObject({baseAmount:'200.00',finalAmount:'160.00'});});
  test('percent half-cent rounds to nearest cent without floating-point calculation',()=>expect(Promos.calculate(105,{discountType:'PERCENT',discountValue:1000})).toBe(11));
  test.each([['PERCENT','100'],['FIXED','25']])('rejects zero or negative totals %s',async(discountType,discountValue)=>{await createPromo({discountType,discountValue});await expect(quote({promoCode:'SAVE20'})).rejects.toMatchObject({code:'PROMO_MINIMUM_PAYMENT'});});
  test.each(['$bad','x','a'.repeat(41),{$ne:null}])('rejects malformed code %j',async promoCode=>{await expect(quote({promoCode})).rejects.toMatchObject({code:'PROMO_INVALID'});expect(await Usage.countDocuments()).toBe(0);});
  test('missing promo is safe and validation never consumes',async()=>{await expect(quote({promoCode:'MISSING'})).rejects.toMatchObject({code:'PROMO_INVALID'});expect(await Usage.countDocuments()).toBe(0);});
});

describe('atomic checkout and capture', () => {
  test('last global slot is reserved by only one concurrent buyer', async () => {
    await createPromo({ totalLimit:1 });
    const other = await User.create({firebaseUid:'other',email:'other@example.test',role:'teacher',plan:free._id});
    const [a,b] = await Promise.all([quote({promoCode:'SAVE20'}),quote({userId:other._id,promoCode:'SAVE20'})]);
    const results = await Promise.allSettled([prepare(a),prepare(b,other)]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1); expect((await Promo.findOne()).allocated).toBe(1);
  });
  test('capture retry and webhook consume once; snapshot survives promo edits', async () => {
    const promo = await createPromo({perUserLimit:1}); const q = await quote({promoCode:'SAVE20'}); const {attemptId,client} = await prepare(q);
    await Billing.transaction(session=>Promos.save(promoInput({discountValue:'5',active:false}),admin._id,promo._id,session));
    expect(client.createOrder.mock.calls[0][0].purchase_units[0].amount.value).toBe('16.00');
    expect((await Purchase.captureOrder({user,attemptId,client})).fulfilled).toBe(true);
    await Purchase.captureOrder({user,attemptId,client}); await Purchase.reconcileCaptureWebhook({orderId:client.order.id,client});
    expect(await Entitlement.countDocuments()).toBe(1); expect((await Promo.findOne()).consumed).toBe(1);
    expect((await Usage.findOne()).consumed).toBe(1); expect(client.captureOrder).toHaveBeenCalledTimes(1);
    await Billing.transaction(session=>Promos.save(promoInput({perUserLimit:1}),admin._id,promo._id,session));
    await expect(quote({promoCode:'SAVE20'})).rejects.toMatchObject({code:'PROMO_USER_LIMIT'});
  });
  test('cancellation releases exactly once',async()=>{await createPromo({totalLimit:1});const {attemptId}=await prepare(await quote({promoCode:'SAVE20'}));await Purchase.cancel({user,attemptId});await Purchase.cancel({user,attemptId});expect((await Promo.findOne()).allocated).toBe(0);expect((await Usage.findOne()).allocated).toBe(0);});
  test('expired abandoned order releases its reservation',async()=>{await createPromo({totalLimit:1});const {attemptId}=await prepare(await quote({promoCode:'SAVE20'}));await Attempt.updateOne({attemptId},{$set:{checkoutExpiresAt:new Date(0)}});await Billing.expireReservations();expect((await Promo.findOne()).allocated).toBe(0);});
  test.each([['19.00','USD'],['20.00','EUR']])('mismatched capture %s %s cannot fulfill',async(value,currency)=>{const {attemptId}=await prepare(await quote());await expect(Purchase.captureOrder({user,attemptId,client:provider(attemptId,value,currency)})).rejects.toBeTruthy();expect(await Entitlement.countDocuments()).toBe(0);});
  test('same create retry uses immutable quote and does not reserve twice',async()=>{await createPromo();const q=await quote({promoCode:'SAVE20'});const {attemptId,client}=await prepare(q);await Purchase.createOrder({user,attemptId,quoteId:q.quoteId,planSlug:'pro',billingPeriod:'monthly',client});expect((await Promo.findOne()).allocated).toBe(1);expect(client.createOrder).toHaveBeenCalledTimes(1);});
  test('no-promo checkout fulfills normally',async()=>{const {attemptId,client}=await prepare(await quote());expect((await Purchase.captureOrder({user,attemptId,client})).amount).toBe('20.00');expect(await Promo.countDocuments()).toBe(0);});
});

describe('confirmed upgrade and manual override rules', () => {
  test('half-used $10 term: $20 minus $5 then 20 percent gives $12',async()=>{await paidCurrent();await createPromo();const q=await quote({now:new Date('2026-09-16T00:00:00Z'),promoCode:'SAVE20'});expect(q).toMatchObject({transition:'upgrade',prorationCredit:'5.00',subtotalBeforeDiscount:'15.00',discountAmount:'3.00',finalAmount:'12.00'});});
  test.each(['monthly','annual'])('upgrade %s becomes immediate new full term',async billingPeriod=>{
    const now=new Date();const previous=await paidCurrent(essential,new Date(now.getTime()-86400000),new Date(now.getTime()+29*86400000));
    const q=await quote({billingPeriod});const {attemptId,client}=await prepare(q);const result=await Purchase.captureOrder({user,attemptId,client});
    const granted=await Entitlement.findById(result.entitlement.id);expect(granted.status).toBe('active');expect(granted.startsAt>=now).toBe(true);
    expect(granted.endsAt.toISOString()).toBe(Terms.addCalendarPeriod(granted.startsAt,billingPeriod).toISOString());expect((await Entitlement.findById(previous._id)).status).toBe('superseded');
  });
  test.each([['essential','downgrade'],['pro','renewal']])('%s keeps current paid benefits',async(planSlug,transition)=>{const now=new Date();const current=await paidCurrent(pro,now,new Date(now.getTime()+20*86400000),'20.00');const q=await quote({planSlug});expect(q.transition).toBe(transition);const {attemptId,client}=await prepare(q);const result=await Purchase.captureOrder({user,attemptId,client});expect(result.entitlement.status).toBe('scheduled');expect(new Date(result.entitlement.startsAt).toISOString()).toBe(current.endsAt.toISOString());expect((await Entitlement.findById(current._id)).status).toBe('active');});
  test('unverified historical payment and scheduled upgrade block safely',async()=>{const now=new Date();const current=await paidCurrent(essential,now,new Date(now.getTime()+86400000));await Attempt.deleteOne({_id:current.paymentAttemptId});await expect(quote()).rejects.toMatchObject({code:'PRORATION_REVIEW_REQUIRED'});});
  test.each(['free','essential','pro'])('admin assigns %s, supersedes all conflicting records, preserves credits/history',async planSlug=>{
    const now=new Date();const current=await paidCurrent(pro,now,new Date(now.getTime()+86400000),'20.00');
    const future=await Entitlement.create({userId:user._id,planId:essential._id,planSlug:'essential',billingPeriod:'monthly',source:'paypal',status:'scheduled',startsAt:current.endsAt,endsAt:Terms.addCalendarPeriod(current.endsAt,'monthly')});
    await Wallet.create({userId:user._id,monthlyCredits:300,monthlyCreditsUsed:7,purchasedCredits:19,bonusCredits:11,billingCycleStart:now,billingCycleEnd:current.endsAt,lastCreditReset:now});
    const preview=await Billing.previewAdmin({actor:admin._id,email:' TEACHER@example.test ',planSlug,billingPeriod:'annual',reason:'Support adjustment'});
    const operationId=crypto.randomUUID();const first=await Billing.assignAdmin({actor:admin._id,quoteId:preview.quoteId,operationId});
    expect(String((await Billing.assignAdmin({actor:admin._id,quoteId:preview.quoteId,operationId}))._id)).toBe(String(first._id));
    expect((await Entitlement.findById(current._id)).status).toBe('superseded');expect((await Entitlement.findById(future._id)).status).toBe('superseded');
    expect(await Entitlement.countDocuments()).toBe(3);expect(await Attempt.countDocuments()).toBe(1);expect(await Audit.countDocuments({action:'ADMIN_PLAN_ASSIGNMENT'})).toBe(1);
    await require('../src/services/credit.service').getOrCreateWallet(user._id);
    expect(await Wallet.findOne({userId:user._id})).toMatchObject({purchasedCredits:19,bonusCredits:11,monthlyCreditsUsed:7});
  });
  test('active recurring billing blocks preview with no external or internal mutations',async()=>{await User.updateOne({_id:user._id},{$set:{paypalSubscriptionId:'I-LEGACY',paypalSubscriptionStatus:'ACTIVE'}});await expect(Billing.previewAdmin({actor:admin._id,email:user.email,planSlug:'pro',billingPeriod:'monthly',reason:'Review'})).rejects.toMatchObject({code:'LEGACY_SUBSCRIPTION_ACTIVE'});expect(await Entitlement.countDocuments()).toBe(0);expect((await User.findById(user._id)).paypalSubscriptionId).toBe('I-LEGACY');});
  test('pending checkout blocks admin assignment',async()=>{const preview=await Billing.previewAdmin({actor:admin._id,email:user.email,planSlug:'pro',billingPeriod:'monthly',reason:'Review'});await prepare(await quote());await expect(Billing.assignAdmin({actor:admin._id,quoteId:preview.quoteId,operationId:crypto.randomUUID()})).rejects.toMatchObject({code:'BILLING_CHECKOUT_PENDING'});});
  test.each(['2024-01-31T12:00:00Z','2024-02-29T12:00:00Z','2025-02-28T12:00:00Z'])('calendar boundaries %s',start=>{const end=Terms.addCalendarPeriod(start,'monthly');expect(end.getUTCDate()).toBeLessThanOrEqual(new Date(start).getUTCDate());expect(Money.prorate(1000,start,end,new Date(start))).toBe(1000);expect(Money.prorate(1000,start,end,end)).toBe(0);});
});

describe('backend authorization and request authority',()=>{
  test('ambiguous normalized email is blocked without guessing',async()=>{await User.create({firebaseUid:'duplicate',email:user.email,role:'teacher'});await expect(Billing.lookup(user.email)).rejects.toMatchObject({statusCode:409});});
  test('quote cannot be used by a different buyer',async()=>{const q=await quote();const other=await User.create({firebaseUid:'second',email:'second@example.test',role:'teacher',plan:free._id});await expect(prepare(q,other)).rejects.toMatchObject({code:'BILLING_QUOTE_EXPIRED'});expect(await Attempt.countDocuments()).toBe(0);});
  test('API preview/confirm audits once and old set endpoint cannot bypass confirmation',async()=>{
    const auth=`Bearer ${token(admin)}`;
    const preview=await request(app).post('/api/billing/admin/preview').set('Authorization',auth).send({email:user.email,planSlug:'pro',billingPeriod:'monthly',reason:'Support'});
    expect(preview.status).toBe(200);
    const body={quoteId:preview.body.data.quoteId,operationId:crypto.randomUUID()};
    expect((await request(app).post('/api/billing/admin/assign').set('Authorization',auth).send(body)).status).toBe(200);
    expect((await request(app).post('/api/billing/admin/assign').set('Authorization',auth).send(body)).status).toBe(200);
    expect(await Entitlement.countDocuments()).toBe(1);expect(await Attempt.countDocuments()).toBe(0);
    expect((await request(app).post('/api/subscription/set').set('Authorization',auth).send({userId:String(user._id),planId:String(essential._id)})).status).toBe(409);
  });
  test.each(['anonymous','student','teacher'])('%s cannot administer promos or plans',async role=>{
    let auth; if(role!=='anonymous'){const account=role==='teacher'?user:await User.create({firebaseUid:role,email:`${role}@example.test`,role});auth=token(account);}
    for(const path of ['/api/billing/admin/promos','/api/billing/admin/user?email=teacher@example.test']){const call=request(app).get(path);if(auth)call.set('Authorization',`Bearer ${auth}`);expect((await call).status).toBe(role==='anonymous'?401:403);}
    for(const path of ['/api/billing/admin/assign','/api/billing/admin/promos']){const call=request(app).post(path).send({});if(auth)call.set('Authorization',`Bearer ${auth}`);expect((await call).status).toBe(role==='anonymous'?401:403);}
  });
  test('tampered quote price rejected',async()=>{const response=await request(app).post('/api/billing/quote').set('Authorization',`Bearer ${token(user)}`).send({planSlug:'pro',billingPeriod:'monthly',finalAmount:'0.01'});expect(response.status).toBe(400);});
  test('admin lookup and missing email use safe responses',async()=>{expect((await request(app).get('/api/billing/admin/user').query({email:'teacher@example.test'}).set('Authorization',`Bearer ${token(admin)}`)).body.data.currentPlan).toBe('Free');await expect(Billing.lookup('absent@example.test')).rejects.toMatchObject({statusCode:404});});
});

describe('post-implementation race and recovery audit',()=>{
  test('a future paid term without current coverage cannot be overlapped by a new purchase',async()=>{
    const startsAt=new Date(Date.now()+86400000);
    await Entitlement.create({userId:user._id,planId:essential._id,planSlug:'essential',source:'paypal',status:'scheduled',billingPeriod:'monthly',startsAt,endsAt:Terms.addCalendarPeriod(startsAt,'monthly')});
    await expect(quote()).rejects.toMatchObject({code:'SCHEDULED_PLAN_REVIEW_REQUIRED'});expect(await Attempt.countDocuments()).toBe(0);
  });
  test('create retry after ambiguous capture never creates another provider order',async()=>{
    const q=await quote();const {attemptId,client}=await prepare(q);
    await Attempt.updateOne({attemptId},{$set:{status:'failed',failureClass:'retryable',captureAttemptedAt:new Date()}});
    await Purchase.createOrder({user,attemptId,quoteId:q.quoteId,planSlug:'pro',billingPeriod:'monthly',client});
    expect(client.createOrder).toHaveBeenCalledTimes(1);
  });
  test('manual term expiry cannot revive cancelled legacy paid-through access',async()=>{
    await User.updateOne({_id:user._id},{$set:{paypalSubscriptionId:'I-CANCELLED',paypalSubscriptionStatus:'CANCELLED',paypalCurrentPeriodEnd:new Date(Date.now()+365*86400000)}});
    const q=await Billing.previewAdmin({actor:admin._id,email:user.email,planSlug:'essential',billingPeriod:'monthly',reason:'Resolved recurring billing'});
    const granted=await Billing.assignAdmin({actor:admin._id,quoteId:q.quoteId,operationId:crypto.randomUUID()});
    expect((await Terms.resolveEffectivePlan(await User.findById(user._id),new Date(granted.endsAt.getTime()+1))).plan.slug).toBe('free');
    expect((await User.findById(user._id)).paypalSubscriptionId).toBe('I-CANCELLED');
  });
  test('simultaneous admin confirmations result in one grant and one audit',async()=>{
    const q=await Billing.previewAdmin({actor:admin._id,email:user.email,planSlug:'pro',billingPeriod:'monthly',reason:'Support'});
    const input={actor:admin._id,quoteId:q.quoteId,operationId:crypto.randomUUID()};
    await Promise.allSettled([Billing.assignAdmin(input),Billing.assignAdmin(input)]);
    await Billing.assignAdmin(input);expect(await Entitlement.countDocuments()).toBe(1);expect(await Audit.countDocuments({action:'ADMIN_PLAN_ASSIGNMENT'})).toBe(1);
  });
  test('expired quote and edited promo cannot reserve or call PayPal',async()=>{
    const promo=await createPromo();const q=await quote({promoCode:'SAVE20'});
    await Billing.transaction(session=>Promos.save(promoInput({discountValue:'10'}),admin._id,promo._id,session));
    await expect(prepare(q)).rejects.toMatchObject({code:'PROMO_CHANGED'});expect(await Attempt.countDocuments()).toBe(0);
    const fresh=await quote();await require('../src/models/BillingQuote').updateOne({_id:fresh.quoteId},{$set:{expiresAt:new Date(0)}});
    await expect(prepare(fresh)).rejects.toMatchObject({code:'BILLING_QUOTE_EXPIRED'});
  });
  test('simultaneous create callbacks share one reservation and provider request',async()=>{
    await createPromo();const q=await quote({promoCode:'SAVE20'});const attemptId=crypto.randomUUID(),client=provider(attemptId,q.finalAmount);
    const input={user,planSlug:'pro',billingPeriod:'monthly',quoteId:q.quoteId,attemptId,client};
    const results=await Promise.allSettled([Purchase.createOrder(input),Purchase.createOrder(input)]);
    expect(results.some(r=>r.status==='fulfilled')).toBe(true);expect(await Attempt.countDocuments()).toBe(1);expect((await Promo.findOne()).allocated).toBe(1);expect(client.createOrder).toHaveBeenCalledTimes(1);
  });
  test('simultaneous captures cannot grant or redeem twice',async()=>{
    await createPromo();const {attemptId,client}=await prepare(await quote({promoCode:'SAVE20'}));
    await Promise.allSettled([Purchase.captureOrder({user,attemptId,client}),Purchase.captureOrder({user,attemptId,client})]);
    expect(await Entitlement.countDocuments()).toBe(1);expect((await Promo.findOne()).consumed).toBe(1);expect(client.captureOrder).toHaveBeenCalledTimes(1);
  });
  test('uncertain expired capture is retained and reconciled without a second capture',async()=>{
    await createPromo();const {attemptId,client}=await prepare(await quote({promoCode:'SAVE20'}));
    await Attempt.updateOne({attemptId},{$set:{status:'failed',failureClass:'retryable',captureAttemptedAt:new Date(),checkoutExpiresAt:new Date(0)}});
    await Billing.expireReservations();expect((await Promo.findOne()).allocated).toBe(1);
    await expect(Purchase.cancel({user,attemptId})).rejects.toMatchObject({code:'BILLING_RECONCILIATION_REQUIRED'});
    expect((await Purchase.captureOrder({user,attemptId,client})).fulfilled).toBe(true);expect(client.captureOrder).not.toHaveBeenCalled();expect(client.getOrder).toHaveBeenCalledTimes(1);
  });
  test('source refund after quoting blocks fulfillment and keeps payment for review',async()=>{
    const now=new Date();const current=await paidCurrent(essential,now,new Date(now.getTime()+86400000));
    const {attemptId,client}=await prepare(await quote());await Attempt.updateOne({_id:current.paymentAttemptId},{$set:{status:'refunded',refundedAt:new Date()}});
    await expect(Purchase.captureOrder({user,attemptId,client})).rejects.toMatchObject({code:'BILLING_REVIEW_REQUIRED'});
    expect((await Attempt.findOne({attemptId})).status).toBe('review_required');expect(await Entitlement.countDocuments()).toBe(1);
  });
  test('future paid term requires explicit upgrade review',async()=>{
    const now=new Date();const current=await paidCurrent(essential,now,new Date(now.getTime()+86400000));
    await Entitlement.create({userId:user._id,planId:essential._id,planSlug:'essential',source:'paypal',status:'scheduled',billingPeriod:'monthly',startsAt:current.endsAt,endsAt:Terms.addCalendarPeriod(current.endsAt,'monthly')});
    await expect(quote()).rejects.toMatchObject({code:'SCHEDULED_PLAN_REVIEW_REQUIRED'});
  });
  test('manual superseded future terms never reactivate; content remains untouched',async()=>{
    const now=new Date(),end=new Date(now.getTime()+86400000);const current=await paidCurrent(pro,now,end,'20.00');
    await Entitlement.create({userId:user._id,planId:pro._id,planSlug:'pro',source:'paypal',status:'scheduled',billingPeriod:'monthly',startsAt:end,endsAt:Terms.addCalendarPeriod(end,'monthly')});
    for(const name of ['classes','assignments','submissions','files'])await mongoose.connection.collection(name).insertOne({billingPreservationMarker:true,userId:user._id});
    const q=await Billing.previewAdmin({actor:admin._id,email:user.email,planSlug:'free',billingPeriod:'monthly',reason:'Manual override'});
    await Billing.assignAdmin({actor:admin._id,quoteId:q.quoteId,operationId:crypto.randomUUID()});
    expect((await Terms.resolveEffectivePlan(await User.findById(user._id),new Date(end.getTime()+1))).plan.slug).toBe('free');
    for(const name of ['classes','assignments','submissions','files'])expect(await mongoose.connection.collection(name).countDocuments({billingPreservationMarker:true})).toBe(1);
    expect((await Entitlement.findById(current._id)).status).toBe('superseded');
  });
  test('legacy becomes ACTIVE after preview: confirm blocks and leaves records untouched',async()=>{
    const q=await Billing.previewAdmin({actor:admin._id,email:user.email,planSlug:'pro',billingPeriod:'monthly',reason:'Support'});
    await User.updateOne({_id:user._id},{$set:{paypalSubscriptionId:'I-LEGACY',paypalSubscriptionStatus:'ACTIVE'}});
    await expect(Billing.assignAdmin({actor:admin._id,quoteId:q.quoteId,operationId:crypto.randomUUID()})).rejects.toMatchObject({code:'LEGACY_SUBSCRIPTION_ACTIVE'});
    expect(await Entitlement.countDocuments()).toBe(0);
  });
  test('index migration dry run is read-only and apply is rerunnable in disposable replica set',async()=>{
    const {migrate}=require('../scripts/migratePromoBilling');const db=mongoose.connection.db;
    const before=await db.collection('paymentpurchaseattempts').listIndexes().toArray();
    const dry=await migrate(db);expect(dry.dryRun).toBe(true);expect(dry.indexesCreated).toBe(0);
    expect(await db.collection('paymentpurchaseattempts').listIndexes().toArray()).toEqual(before);
    await migrate(db,{apply:true,backupConfirmed:true});expect((await migrate(db,{apply:true,backupConfirmed:true})).indexesCreated).toBe(0);
  });
});
