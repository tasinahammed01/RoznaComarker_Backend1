const logger = require('./logger');

function safeJsonParse(text) {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch (err) {
    try {
      const cleaned = text
        .replace(/```json/g, '')
        .replace(/```/g, '')
        .trim();
      return JSON.parse(cleaned);
    } catch (err2) {
      logger.error(`AI JSON parse failed: ${err2 && err2.message ? err2.message : err2}`);
      return null;
    }
  }
}

module.exports = { safeJsonParse };
