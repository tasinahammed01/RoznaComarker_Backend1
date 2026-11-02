'use strict';
// Production runs with autoIndex/autoCreate disabled, so the recovery-portal indexes come from the migration script. It must create
// every index (unique hashes, all TTLs) on an empty database and be safe to run again.
const mongoose = require('mongoose');
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');
const { ensureRecoveryPortalIndexes } = require('../scripts/migrateRecoveryPortalIndexes');

jest.setTimeout(60000);
beforeAll(connectInMemoryMongo);
afterAll(disconnectInMemoryMongo);

test('the migration creates every recovery-portal index, including the TTL indexes, and is idempotent', async () => {
  for (const name of ['recoverytokens', 'recoverysessions', 'recoveryemailwindows'])
    await mongoose.connection.db.dropCollection(name).catch(() => undefined);   // start with no collection and no index
  await ensureRecoveryPortalIndexes();
  const summary = await ensureRecoveryPortalIndexes();                          // second run: no error, nothing changes
  const byName = Object.fromEntries(Object.entries(summary).map(([collection, list]) => [collection, Object.fromEntries(list.map(i => [i.name, i]))]));
  expect(byName.recoverytokens.recovery_token_hash_v1).toMatchObject({ key: { tokenHash: 1 }, unique: true });
  expect(byName.recoverytokens.recovery_token_email_v1).toMatchObject({ key: { emailNormalized: 1, createdAt: -1 } });
  expect(byName.recoverytokens.recovery_token_purge_v1).toMatchObject({ key: { purgeAt: 1 }, expireAfterSeconds: 0 });
  expect(byName.recoverysessions.recovery_session_hash_v1).toMatchObject({ key: { sessionHash: 1 }, unique: true });
  expect(byName.recoverysessions.recovery_session_token_v1).toMatchObject({ key: { tokenId: 1 } });
  expect(byName.recoverysessions.recovery_session_purge_v1).toMatchObject({ key: { expiresAt: 1 }, expireAfterSeconds: 3600 });
  expect(byName.recoveryemailwindows.recovery_email_window_purge_v1).toMatchObject({ key: { expiresAt: 1 }, expireAfterSeconds: 0 });
});
