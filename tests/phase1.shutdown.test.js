const { createShutdown } = require('../src/services/shutdown.service');
test('shutdown closes HTTP, browser and database exactly once', async () => {
  const server = { close: jest.fn(cb => cb()), closeIdleConnections: jest.fn() };
  const closeBrowser = jest.fn(), disconnect = jest.fn(), exit = jest.fn();
  const stop = createShutdown({ getServer: () => server, closeBrowser, disconnect, exit, logger: { warn() {} } });
  await Promise.all([stop('SIGTERM'), stop('SIGINT')]);
  for (const fn of [server.close, closeBrowser, disconnect, exit]) expect(fn).toHaveBeenCalledTimes(1);
  expect(exit).toHaveBeenCalledWith(0);
});
test('open SSE connections cannot prevent forced shutdown', async () => {
  jest.useFakeTimers();
  const server = { close: jest.fn(), closeAllConnections: jest.fn() }, exit = jest.fn();
  const stop = createShutdown({ getServer: () => server, closeBrowser: jest.fn(), disconnect: jest.fn(), exit, logger: { warn() {} }, timeoutMs: 20 });
  stop('unhandledRejection', 1);
  await Promise.resolve();
  await jest.advanceTimersByTimeAsync(20);
  expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
  expect(exit).toHaveBeenCalledWith(1);
  jest.useRealTimers();
});
test('browser failure still closes database and exits with failure', async () => {
  const disconnect = jest.fn(), exit = jest.fn();
  await createShutdown({ getServer: () => null, closeBrowser: async () => { throw new Error('closed'); }, disconnect, exit, logger: { warn() {} } })('fatal', 1);
  expect(disconnect).toHaveBeenCalledTimes(1); expect(exit).toHaveBeenCalledWith(1);
});
test('in-flight HTTP requests drain before browser and Mongo close', async () => {
  let finish;
  const server = { close: cb => { finish = cb; } }, closeBrowser = jest.fn(), disconnect = jest.fn();
  const stopped = createShutdown({ getServer: () => server, closeBrowser, disconnect, exit: jest.fn(), logger: { warn() {} } })('SIGTERM');
  await Promise.resolve();
  expect(closeBrowser).not.toHaveBeenCalled(); expect(disconnect).not.toHaveBeenCalled();
  finish(); await stopped;
  expect(closeBrowser).toHaveBeenCalledTimes(1); expect(disconnect).toHaveBeenCalledTimes(1);
});
