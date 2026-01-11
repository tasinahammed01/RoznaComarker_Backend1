function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sanitizeValue(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }

  if (isPlainObject(value)) {
    const out = {};

    for (const [key, raw] of Object.entries(value)) {
      const safeKey = String(key).replace(/^\$+/, '').replace(/\./g, '');
      out[safeKey] = sanitizeValue(raw);
    }

    return out;
  }

  return value;
}

function sanitizeRequest(req, res, next) {
  try {
    if (req.body) req.body = sanitizeValue(req.body);
    if (req.params) req.params = sanitizeValue(req.params);

    // Express 5 req.query is a getter-only object in some setups.
    // Do not reassign it; just sanitize nested plain objects if present.
    if (req.query && isPlainObject(req.query)) {
      for (const [key, raw] of Object.entries(req.query)) {
        const safeKey = String(key).replace(/^\$+/, '').replace(/\./g, '');
        if (safeKey !== key) {
          // avoid mutations that could break query parsers; skip key rewrite
          continue;
        }
        if (isPlainObject(raw) || Array.isArray(raw)) {
          req.query[key] = sanitizeValue(raw);
        }
      }
    }

    return next();
  } catch (err) {
    err.statusCode = err.statusCode || 500;
    return next(err);
  }
}

module.exports = {
  sanitizeRequest
};
