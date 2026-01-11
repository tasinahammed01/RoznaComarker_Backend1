const { validationResult } = require('express-validator');

function handleValidationResult(req, res, next) {
  const result = validationResult(req);

  if (result.isEmpty()) {
    return next();
  }

  const first = result.array({ onlyFirstError: true })[0];
  const message = first && first.msg ? String(first.msg) : 'Validation error';

  return res.status(400).json({
    success: false,
    message
  });
}

module.exports = {
  handleValidationResult
};
