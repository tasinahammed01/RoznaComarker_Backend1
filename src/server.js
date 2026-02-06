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

  const port = process.env.PORT || env.PORT || 5000;
  server = app.listen(port, '0.0.0.0', () => {
    logger.info(
      `Server running on port ${port} (${env.NODE_ENV})`
    );
  });
}

start().catch((err) => {
  logger.error('Startup failed');
  logger.error(err);
  process.exit(1);
});
