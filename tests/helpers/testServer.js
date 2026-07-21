const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo;

function assertIsolatedTestDatabase(uri) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing test database startup unless NODE_ENV=test.');
  const databaseName = new URL(uri).pathname.replace(/^\//, '').split('?')[0];
  if (!/(?:^|[_-])test(?:$|[_-])/i.test(databaseName)) {
    throw new Error(`Refusing non-test database name: ${databaseName || '(empty)'}`);
  }
  return databaseName;
}

async function connectInMemoryMongo() {
  mongo = await MongoMemoryServer.create({ instance: { dbName: 'projectrozna_http_test' } });
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
  connectInMemoryMongo,
  disconnectInMemoryMongo,
  clearDatabase,
  assertIsolatedTestDatabase
};
