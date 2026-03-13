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
      console.error("AI JSON parse failed:", err2);
      return null;
    }
  }
}

module.exports = { safeJsonParse };
