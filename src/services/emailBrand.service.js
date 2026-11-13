'use strict';
// The Rubrilo brand row at the top of HTML emails: the supplied horizontal full-colour logo (icon + name in ONE image) as a PNG (email
// clients do not reliably show SVG, base64 or attached images). The PNG is the frontend's
// public/logo_and_icon/logo/rubrilo-logo-horizontal-fullcolor@512w.png (512x164, shown at 156x50: the same ratio), served by the website,
// so it must be an absolute URL: EMAIL_LOGO_URL if set, otherwise FRONTEND_URL + that path.
// With neither usable, the row shows the "Rubrilo" name as text alone (never a broken image).

const LOGO_PATH = '/logo_and_icon/logo/rubrilo-logo-horizontal-fullcolor@512w.png';
const WIDTH = 156;
const HEIGHT = 50;
const escapeAttr = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

/** The absolute http(s) URL of the email logo, or null when none can be built. */
function emailLogoUrl(env = process.env) {
  const absolute = value => {
    try { const url = new URL(String(value || '').trim()); return ['https:', 'http:'].includes(url.protocol) ? url : null; } catch { return null; }
  };
  const override = absolute(env.EMAIL_LOGO_URL);
  if (override) return override.href;
  const site = absolute(env.FRONTEND_URL);
  if (!site) return null;
  // Relative to the site's own path (a site served under /app/ keeps it); a leading "/" would drop it.
  return new URL(LOGO_PATH.slice(1), `${site.origin}${site.pathname.replace(/\/+$/, '')}/`).href;
}

/** The brand row (a one-row table, as the emails' layout uses): the logo image, or the "Rubrilo" name as text when no URL is usable. */
function emailBrandHeaderHtml(env = process.env) {
  const logo = emailLogoUrl(env);
  const cell = logo
    ? `<td width="${WIDTH}" height="${HEIGHT}" style="width:${WIDTH}px;height:${HEIGHT}px;"><img src="${escapeAttr(logo)}" width="${WIDTH}" height="${HEIGHT}" alt="Rubrilo" style="display:block;width:${WIDTH}px;height:${HEIGHT}px;border:0;outline:none;text-decoration:none;"></td>`
    : '<td><strong style="font-size:24px;color:#14264d;">Rubrilo</strong></td>';
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>\n${cell}</tr></table>`;
}

module.exports = { emailLogoUrl, emailBrandHeaderHtml, LOGO_PATH };
