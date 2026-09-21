'use strict';
process.env.NODE_ENV = 'test';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const packageJson = require('../package.json');
const { migrate, parseCliArgs } = require('../scripts/migrateBillingContracts');
const { assertIsolatedTestDatabase } = require('./helpers/testServer');

let mongo;
let connection;
let db;

async function seedCatalog() {
  await db.collection('plans').insertMany([
    { name: 'Free', slug: ' Free ', isActive: true },
    { name: 'Essential monthly', slug: ' Essential_Monthly ', isActive: true },
    { name: 'Institution', slug: 'institution', isActive: true }
  ]);
  await db.collection('creditpacks').insertMany([
    { code: 'CREDITS_10', credits: 10, price: 1.99, currency: 'USD', active: true,
      allowedPlans: [' Essential_Monthly '], displayOrder: 1 },
    { code: 'INSTITUTION_100', credits: 100, price: 49.99, currency: 'USD', active: true,
      allowedPlans: ['institution'], displayOrder: 2 }
  ]);
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { dbName: 'billing_migration_test' } });
  const uri = mongo.getUri('billing_migration_test');
  assertIsolatedTestDatabase(uri);
  connection = await mongoose.createConnection(uri, { autoIndex: false, autoCreate: false }).asPromise();
  db = connection.db;
});

afterAll(async () => {
  if (connection) await connection.close();
  if (mongo) await mongo.stop();
});

beforeEach(async () => {
  await db.dropDatabase();
  await seedCatalog();
});

test('CLI defaults to dry-run with no flags', () => {
  expect(parseCliArgs([])).toEqual({ apply: false, backupConfirmed: false });
});

test('apply intent requires backup confirmation', () => {
  expect(() => parseCliArgs(['--apply'])).toThrow('BACKUP_CONFIRMATION_REQUIRED');
});

test('explicit apply and backup confirmation select apply mode', () => {
  expect(parseCliArgs(['--apply', '--backup-confirmed'])).toEqual({ apply: true, backupConfirmed: true });
});

test('unknown and duplicate CLI flags fail closed', () => {
  expect(() => parseCliArgs(['--apply=true', '--backup-confirmed'])).toThrow('UNKNOWN_CLI_ARGUMENT');
  expect(() => parseCliArgs(['--apply', '--apply', '--backup-confirmed'])).toThrow('UNKNOWN_CLI_ARGUMENT');
});

test('backup confirmation alone does not activate writes', () => {
  expect(parseCliArgs(['--backup-confirmed'])).toEqual({ apply: false, backupConfirmed: true });
});

test('package scripts encode dry-run and apply intent without npm argument forwarding', () => {
  expect(packageJson.scripts['pricing:migrate-billing']).toBe('node scripts/migrateBillingContracts.js');
  expect(packageJson.scripts['pricing:migrate-billing:apply'])
    .toBe('node scripts/migrateBillingContracts.js --apply --backup-confirmed');
});

test('dry-run performs zero document or index writes', async () => {
  const beforePlans = await db.collection('plans').find({}).sort({ name: 1 }).toArray();
  const beforePacks = await db.collection('creditpacks').find({}).sort({ code: 1 }).toArray();
  const beforePlanIndexes = await db.collection('plans').indexes();
  const result = await migrate(db, parseCliArgs([]));
  expect(result).toMatchObject({ dryRun: true, plans: 3, packs: 2 });
  expect(await db.collection('plans').find({}).sort({ name: 1 }).toArray()).toEqual(beforePlans);
  expect(await db.collection('creditpacks').find({}).sort({ code: 1 }).toArray()).toEqual(beforePacks);
  expect(await db.collection('plans').indexes()).toEqual(beforePlanIndexes);
  await expect(db.collection('paymentcheckoutattempts').indexes()).rejects.toMatchObject({ code: 26 });
});

test('isolated apply is idempotent, installs indexes, and only changes eligibility metadata', async () => {
  const options = parseCliArgs(['--apply', '--backup-confirmed']);
  await expect(migrate(db, options)).resolves.toMatchObject({ applied: true, pricesChanged: false });
  await expect(migrate(db, options)).resolves.toMatchObject({ applied: true, pricesChanged: false });

  const personal = await db.collection('creditpacks').findOne({ code: 'CREDITS_10' });
  expect(personal).toMatchObject({ credits: 10, price: 1.99, currency: 'USD', allowedPlans: ['essential_monthly', 'free'] });
  const institution = await db.collection('creditpacks').findOne({ code: 'INSTITUTION_100' });
  expect(institution).toMatchObject({ credits: 100, price: 49.99, currency: 'USD', allowedPlans: ['institution'] });

  const planIndex = (await db.collection('plans').indexes()).find(index => index.key.slug === 1);
  expect(planIndex).toMatchObject({ unique: true });
  const checkoutIndex = (await db.collection('paymentcheckoutattempts').indexes())
    .find(index => index.key.activeOperationKey === 1);
  expect(checkoutIndex).toMatchObject({ unique: true,
    partialFilterExpression: { activeOperationKey: { $type: 'string' } } });
});

test('overlapping checkout owners stop migration before any catalog write', async () => {
  const userId = new mongoose.Types.ObjectId();
  await db.collection('paymentcheckoutattempts').insertMany([
    { provider: 'paypal', attemptId: 'one', userId, status: 'creating' },
    { provider: 'paypal', attemptId: 'two', userId, status: 'approval_pending' }
  ]);
  await expect(migrate(db, { apply: true, backupConfirmed: true }))
    .rejects.toThrow('CHECKOUT_CONFLICT_RECONCILE_MANUALLY');
  expect((await db.collection('plans').findOne({ name: 'Free' })).slug).toBe(' Free ');
  expect(await db.collection('paymentcheckoutattempts').countDocuments({ activeOperationKey: { $exists: true } })).toBe(0);
});

test('payment acceptance still fails closed when the checkout lock index is absent', async () => {
  let verifyCheckoutIndex;
  jest.isolateModules(() => {
    jest.doMock('../src/models/PaymentCheckoutAttempt', () => ({
      db: { db: {} },
      collection: { indexes: jest.fn().mockResolvedValue([{ name: '_id_', key: { _id: 1 } }]) }
    }));
    ({ verifyCheckoutIndex } = require('../src/services/paymentIndexContract.service'));
  });
  await expect(verifyCheckoutIndex()).rejects.toMatchObject({ code: 'PAYMENT_INDEX_REQUIRED', statusCode: 503 });
  jest.dontMock('../src/models/PaymentCheckoutAttempt');
});
