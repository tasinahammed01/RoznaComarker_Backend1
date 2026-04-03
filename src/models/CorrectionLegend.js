const mongoose = require('mongoose');

const correctionLegendSchema = new mongoose.Schema({}, {
  strict: false,
  collection: 'correctionLegend'
});

module.exports = mongoose.model('CorrectionLegend', correctionLegendSchema);
