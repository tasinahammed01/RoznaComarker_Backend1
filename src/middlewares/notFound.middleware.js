const { ApiError } = require('./error.middleware');

function notFound(req, res, next) {
  next(new ApiError(404, 'Route not found'));
}

module.exports = notFound;
