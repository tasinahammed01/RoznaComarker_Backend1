'use strict';
// The in-memory server's start is retried for a reserved port only. Any other failure must still stop the suite at once.
const { retryOnReservedPort } = require('./helpers/testServer');

const reserved = () => Object.assign(new Error('listen EACCES: permission denied 0.0.0.0:49689'), { code: 'EACCES', syscall: 'listen' });

describe('retryOnReservedPort', () => {
  test('a reserved port is retried, and the started server is returned', async () => {
    const start = jest.fn().mockRejectedValueOnce(reserved()).mockRejectedValueOnce(reserved()).mockResolvedValue('server');
    await expect(retryOnReservedPort(start)).resolves.toBe('server');
    expect(start).toHaveBeenCalledTimes(3);
  });
  test('it gives up after the last attempt, with the real error', async () => {
    const start = jest.fn().mockRejectedValue(reserved());
    await expect(retryOnReservedPort(start, 3)).rejects.toThrow('listen EACCES');
    expect(start).toHaveBeenCalledTimes(3);
  });
  test('any other failure is not retried', async () => {
    for (const error of [new Error('binary not found'), Object.assign(new Error('in use'), { code: 'EADDRINUSE', syscall: 'listen' }), Object.assign(new Error('denied'), { code: 'EACCES', syscall: 'open' })]) {
      const start = jest.fn().mockRejectedValue(error);
      await expect(retryOnReservedPort(start)).rejects.toBe(error);
      expect(start).toHaveBeenCalledTimes(1);
    }
  });
});
