const mongoose = require('mongoose');
const { MongoMemoryServer, MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo;

function assertIsolatedTestDatabase(uri) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing test database startup unless NODE_ENV=test.');
  const databaseName = new URL(uri).pathname.replace(/^\//, '').split('?')[0];
  if (!/(?:^|[_-])test(?:$|[_-])/i.test(databaseName)) {
    throw new Error(`Refusing non-test database name: ${databaseName || '(empty)'}`);
  }
  return databaseName;
}

// Windows reserves ranges of ports it does not report as busy, so the random free port the in-memory server picks can fail with "listen EACCES".
// That is the machine, not the test: pick another port. Only this error is retried; anything else fails at once.
const RESERVED_PORT_ATTEMPTS = 5;
async function retryOnReservedPort(start, attempts = RESERVED_PORT_ATTEMPTS) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await start();
    } catch (error) {
      const reserved = error?.code === 'EACCES' && error?.syscall === 'listen';
      if (!reserved || attempt >= attempts) throw error;
    }
  }
}

async function connectInMemoryMongo({ replicaSet = false } = {}) {
  mongo = await retryOnReservedPort(() => (replicaSet ? MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
    : MongoMemoryServer.create({ instance: { dbName: 'projectrozna_http_test' } })));
  const uri = mongo.getUri('projectrozna_http_test');
  assertIsolatedTestDatabase(uri);

  await mongoose.connect(uri);
}

async function disconnectInMemoryMongo() {
  try {
    await mongoose.disconnect();
  } catch (err) {
    // ignore
  }

  if (mongo) {
    await mongo.stop();
    mongo = undefined;
  }
}

async function clearDatabase() {
  const collections = mongoose.connection.collections;
  const names = Object.keys(collections);

  for (const name of names) {
    await collections[name].deleteMany({});
  }
}

module.exports = {
  retryOnReservedPort,
  connectInMemoryMongo,
  disconnectInMemoryMongo,
  clearDatabase,
  assertIsolatedTestDatabase
};
