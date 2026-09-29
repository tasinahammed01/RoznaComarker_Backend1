'use strict';
const logger = require('../utils/logger');
const { processExpiriesAndReminders } = require('./planEntitlement.service');

function startPlanEntitlementWorker({ intervalMs = Number(process.env.PLAN_ENTITLEMENT_WORKER_INTERVAL_MS || 15 * 60 * 1000) } = {}) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { await require('./planBilling.service').expireReservations();
      logger.info({ event: 'plan_entitlement_worker', ...(await processExpiriesAndReminders()) }); }
    catch (error) { logger.error({ event: 'plan_entitlement_worker_failed', error: error?.message }); }
    finally { running = false; }
  };
  const timer = setInterval(run, Math.max(60000, intervalMs));
  timer.unref?.();
  void run();
  return { run, stop: () => clearInterval(timer) };
}
module.exports = { startPlanEntitlementWorker };
