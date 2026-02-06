const writingCorrectionsService = require('../services/writingCorrections.service');

async function getLegend(req, res, next) {
  try {
    const legend = await writingCorrectionsService.getLegend();
    return res.json(legend);
  } catch (err) {
    return next(err);
  }
}

async function check(req, res, next) {
  try {
    const payload = req && req.body && typeof req.body === 'object' ? req.body : {};
    const text = typeof payload.text === 'string' ? payload.text : '';
    const language = typeof payload.language === 'string' ? payload.language : undefined;

    const result = await writingCorrectionsService.check({ text, language });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  getLegend,
  check
};
