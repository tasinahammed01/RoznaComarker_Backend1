const {
  escapeRegExp,
  parseDateOnlyUtc,
  startOfNextUtcDay,
} = require("../src/utils/worksheetReportQuery.utils");

describe("worksheet report query helpers", () => {
  test("parses date-only values without local timezone shifting", () => {
    expect(parseDateOnlyUtc("2026-08-14").toISOString()).toBe(
      "2026-08-14T00:00:00.000Z",
    );
  });

  test("creates an exclusive upper bound at the start of the next day", () => {
    const selectedDate = parseDateOnlyUtc("2026-08-14");
    expect(startOfNextUtcDay(selectedDate).toISOString()).toBe(
      "2026-08-15T00:00:00.000Z",
    );
  });

  test("supports a same-day range that includes the full selected UTC day", () => {
    const from = parseDateOnlyUtc("2026-08-14");
    const toExclusive = startOfNextUtcDay(parseDateOnlyUtc("2026-08-14"));
    const atMidnight = new Date("2026-08-14T00:00:00.000Z");
    const lateSubmission = new Date("2026-08-14T23:30:00.000Z");

    expect(atMidnight >= from && atMidnight < toExclusive).toBe(true);
    expect(lateSubmission >= from && lateSubmission < toExclusive).toBe(true);
    expect(new Date("2026-08-15T00:00:00.000Z") < toExclusive).toBe(false);
  });

  test.each(["", "2026-02-30", "2026-13-01", "14-08-2026", "not-a-date"])(
    "rejects invalid date value %p",
    (value) => {
      expect(parseDateOnlyUtc(value)).toBeNull();
    },
  );

  test("escapes regex metacharacters in student searches", () => {
    const input = "Sarah.+(Ahmed)?";
    const expression = new RegExp(escapeRegExp(input), "i");
    expect(expression.test(input)).toBe(true);
    expect(expression.test("SarahZZAhmed")).toBe(false);
  });
});
