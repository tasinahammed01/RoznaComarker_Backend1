'use strict';

function createShutdown({ getServer, closeBrowser, stopBackground = () => {}, disconnect, logger, exit = code => process.exit(code), timeoutMs = 10000 }) {
  let pending;
  return function shutdown(reason, exitCode = 0) {
    if (pending) return pending;
    pending = Promise.resolve().then(async () => {
      logger.warn(`Shutting down (${reason})`);
      // Invoke the timer stop synchronously so shutdown starts draining HTTP in
      // the same turn. Await its result with the other resource closures.
      const stopResult = Promise.resolve(stopBackground());
      const server = getServer();
      const timer = setTimeout(() => {
        server?.closeAllConnections?.();
        exit(1);
      }, timeoutMs);
      const closeHttp = new Promise((resolve, reject) => {
        if (!server) return resolve(true);
        server.close(err => err ? reject(err) : resolve(true));
        server.closeIdleConnections?.();
      });
      let drainTimer;
      const drainDeadline = new Promise(resolve => {
        drainTimer = setTimeout(() => {
          server?.closeAllConnections?.();
          resolve(false);
        }, Math.floor(timeoutMs / 2));
      });
      const [drain] = await Promise.allSettled([Promise.race([closeHttp, drainDeadline])]);
      clearTimeout(drainTimer);
      // Let ordinary requests finish before closing resources they may still use.
      // Long-lived SSE connections are terminated at the drain deadline.
      const results = await Promise.allSettled([
        stopResult,
        Promise.resolve().then(closeBrowser),
        Promise.resolve().then(disconnect)
      ]);
      clearTimeout(timer);
      exit(drain.status === 'rejected' || !drain.value || results.some(result => result.status === 'rejected') ? 1 : exitCode);
    });
    return pending;
  };
}
module.exports = { createShutdown };
