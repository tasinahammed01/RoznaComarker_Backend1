const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo;

async function connectInMemoryMongo() {
  mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri();

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
  clearDatabase
};
