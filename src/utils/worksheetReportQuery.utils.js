function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseDateOnlyUtc(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  if (year < 1000 || monthIndex < 0 || monthIndex > 11 || day < 1 || day > 31)
    return null;

  const parsed = new Date(0);
  parsed.setUTCHours(0, 0, 0, 0);
  parsed.setUTCFullYear(year, monthIndex, day);

  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === monthIndex &&
    parsed.getUTCDate() === day
    ? parsed
    : null;
}

function startOfNextUtcDay(date) {
  const nextDay = new Date(date.getTime());
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  return nextDay;
}

module.exports = {
  escapeRegExp,
  parseDateOnlyUtc,
  startOfNextUtcDay,
};
