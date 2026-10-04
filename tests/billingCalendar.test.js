'use strict';
const { addCalendarPeriod } = require('../src/services/planEntitlement.service');
test.each([
  ['2026-10-03T09:46:09.577Z','monthly','2026-11-03T09:46:09.577Z',31],
  ['2026-11-03T09:46:09.577Z','monthly','2026-12-03T09:46:09.577Z',30],
  ['2026-01-31T09:46:09.577Z','monthly','2026-02-28T09:46:09.577Z',28],
  ['2024-01-31T09:46:09.577Z','monthly','2024-02-29T09:46:09.577Z',29],
  ['2024-02-29T09:46:09.577Z','monthly','2024-03-29T09:46:09.577Z',29],
  ['2025-02-28T09:46:09.577Z','monthly','2025-03-28T09:46:09.577Z',28],
  ['2026-10-03T09:46:09.577Z','annual','2027-10-03T09:46:09.577Z',365],
  ['2023-10-03T09:46:09.577Z','annual','2024-10-03T09:46:09.577Z',366]
])('calendar %s + %s preserves UTC time and clamps month-end', (start, period, expected, days) => {
  const end = addCalendarPeriod(start, period);
  expect(end.toISOString()).toBe(expected);
  expect((end-new Date(start))/86400000).toBe(days);
});
