const env = require('./config/env');
const connectDB = require('./config/db');
const logger = require('./utils/logger');

const Plan = require('./models/Plan');

const app = require('./app');

let server;

function shutdown(reason) {
  logger.warn(`Shutting down (${reason})`);

  if (server) {
    server.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });
  } else {
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection');
  logger.error(reason);
  shutdown('unhandledRejection');
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception');
  logger.error(err);
  process.exit(1);
});

async function start() {
  await connectDB();

  try {
    await Plan.seedDefaults();
  } catch (err) {
    logger.error('Failed to seed default plans');
    logger.error(err);
    throw err;
  }

  server = app.listen(env.PORT, () => {
    logger.info(
      `Server running on port ${env.PORT} (${env.NODE_ENV})`
    );
  });
}

start().catch((err) => {
  logger.error('Startup failed');
  logger.error(err);
  process.exit(1);
});
