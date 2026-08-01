const { resolveLegend } = require('../services/correctionLegendResolver.service');

async function getLegend(req, res, next) {
  try {
    const legend = await resolveLegend();
    return res.json(legend);
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  getLegend
};
