'use strict';

function getPublicApiUrl(req) {
  const configured = String(process.env.PUBLIC_API_URL || process.env.BASE_URL || '').trim();
  if (configured) {
    const base = configured.replace(/\/+$/, '');
    return process.env.NODE_ENV === 'production' ? base.replace(/^http:\/\//i, 'https://') : base;
  }

  const protocol = process.env.NODE_ENV === 'production' ? 'https' : req.protocol;
  return `${protocol}://${req.get('host')}`.replace(/\/+$/, '');
}

function buildPublicUploadUrl(req, type, filename) {
  return `${getPublicApiUrl(req)}/uploads/${type}/${encodeURIComponent(filename)}`;
}

module.exports = { getPublicApiUrl, buildPublicUploadUrl };
