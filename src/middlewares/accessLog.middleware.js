'use strict';
const morgan = require('morgan');
// Exclude the whole query and Referer: either can contain credentials. Never log Authorization.
morgan.token('safe-path', req => String(req.originalUrl || req.url || '').split('?')[0]);
module.exports = options => morgan(':remote-addr :method :safe-path :status :res[content-length] :response-time ms', options);
