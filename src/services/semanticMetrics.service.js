'use strict';

const counters = { semanticJobsStarted: 0, semanticJobsReused: 0,
  semanticJobsRejectedAsDuplicate: 0, semanticJobsSuperseded: 0 };

function increment(name) {
  if (Object.prototype.hasOwnProperty.call(counters, name)) counters[name] += 1;
}

function snapshot() { return { ...counters }; }
function resetForTests() { for (const key of Object.keys(counters)) counters[key] = 0; }

module.exports = { increment, snapshot, resetForTests };
