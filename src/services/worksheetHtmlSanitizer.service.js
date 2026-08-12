'use strict';

const cheerio = require('cheerio');
const cssTree = require('css-tree');
const sanitizeHtml = require('sanitize-html');

const MAX_WORKSHEET_HTML_BYTES = 750_000;

const ALLOWED_TAGS = [
  'html', 'head', 'title', 'style', 'body',
  'main', 'header', 'footer', 'article', 'section', 'aside', 'nav',
  'div', 'span', 'p', 'br', 'hr', 'strong', 'b', 'em', 'i', 'u', 'small',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'label', 'input', 'textarea', 'select', 'option', 'img'
];

const ALLOWED_CSS_PROPERTIES = new Set([
  'align-content', 'align-items', 'align-self', 'background', 'background-color',
  'background-image', 'border', 'border-bottom', 'border-bottom-color',
  'border-bottom-left-radius', 'border-bottom-right-radius', 'border-bottom-style',
  'border-bottom-width', 'border-collapse', 'border-color', 'border-left',
  'border-left-color', 'border-left-style', 'border-left-width', 'border-radius',
  'border-right', 'border-right-color', 'border-right-style', 'border-right-width',
  'border-spacing', 'border-style', 'border-top', 'border-top-color',
  'border-top-left-radius', 'border-top-right-radius', 'border-top-style',
  'border-top-width', 'border-width', 'bottom', 'box-shadow', 'box-sizing',
  'break-after', 'break-before', 'break-inside', 'clear', 'color', 'column-gap',
  'columns', 'content', 'display', 'flex', 'flex-basis', 'flex-direction',
  'flex-flow', 'flex-grow', 'flex-shrink', 'flex-wrap', 'float', 'font',
  'font-family', 'font-size', 'font-style', 'font-weight', 'gap',
  'grid', 'grid-area', 'grid-auto-columns', 'grid-auto-flow', 'grid-auto-rows',
  'grid-column', 'grid-column-end', 'grid-column-start', 'grid-row',
  'grid-row-end', 'grid-row-start', 'grid-template', 'grid-template-areas',
  'grid-template-columns', 'grid-template-rows', 'height', 'justify-content',
  'justify-items', 'justify-self', 'left', 'letter-spacing', 'line-height',
  'list-style', 'list-style-position', 'list-style-type', 'margin',
  'margin-bottom', 'margin-left', 'margin-right', 'margin-top', 'max-height',
  'max-width', 'min-height', 'min-width', 'object-fit', 'opacity', 'outline',
  'overflow', 'overflow-wrap', 'overflow-x', 'overflow-y', 'padding',
  'padding-bottom', 'padding-left', 'padding-right', 'padding-top',
  'page-break-after', 'page-break-before', 'page-break-inside', 'position',
  'right', 'row-gap', 'table-layout', 'text-align', 'text-decoration',
  'text-indent', 'text-overflow', 'text-transform', 'top', 'transform',
  'transform-origin', 'vertical-align', 'visibility', 'white-space', 'width',
  'word-break', 'word-spacing', 'z-index'
]);

const PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data: https://images.unsplash.com",
  "font-src 'none'",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'"
].join('; ');

function invalidWorksheetHtml() {
  const error = new Error('AI returned an unsafe or invalid worksheet.');
  error.code = 'WORKSHEET_HTML_INVALID';
  return error;
}

function isAllowedImageSource(value) {
  const source = String(value || '').trim();
  if (/^data:image\/(?:png|jpe?g|webp);base64,[a-z0-9+/=\s]+$/iu.test(source)) return true;
  try {
    const url = new URL(source);
    return url.protocol === 'https:' && url.hostname === 'images.unsplash.com';
  } catch {
    return false;
  }
}

function sanitizeCss(css, context = 'stylesheet') {
  let ast;
  try {
    ast = cssTree.parse(String(css || ''), { context, positions: false });
  } catch {
    return '';
  }

  cssTree.walk(ast, {
    enter(node, item, list) {
      if (node.type === 'Atrule') {
        const name = String(node.name || '').toLowerCase();
        if (!['media', 'page'].includes(name)) list?.remove(item);
        return;
      }
      if (node.type !== 'Declaration') return;

      const property = String(node.property || '').toLowerCase();
      let unsafe = !ALLOWED_CSS_PROPERTIES.has(property);
      cssTree.walk(node.value, (valueNode) => {
        if (valueNode.type === 'Url' || valueNode.type === 'Raw') unsafe = true;
        if (valueNode.type === 'Function'
          && ['expression', 'url', 'image-set', '-webkit-image-set'].includes(
            String(valueNode.name || '').toLowerCase())) unsafe = true;
      });
      if (unsafe) list?.remove(item);
    }
  });

  try {
    return cssTree.generate(ast);
  } catch {
    return '';
  }
}

function sanitizeWorksheetHtml(rawHtml) {
  const html = String(rawHtml || '').trim();
  if (!html || Buffer.byteLength(html, 'utf8') > MAX_WORKSHEET_HTML_BYTES) {
    throw invalidWorksheetHtml();
  }

  const markup = sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    // Style is intentionally retained for print layout, then parsed and reduced
    // to the CSS allowlist below before this function returns.
    allowVulnerableTags: true,
    allowedAttributes: {
      html: ['lang', 'dir'],
      '*': ['class', 'style', 'dir'],
      img: ['src', 'alt', 'width', 'height'],
      table: ['summary'], col: ['span'], th: ['colspan', 'rowspan', 'scope'],
      td: ['colspan', 'rowspan'],
      input: ['type', 'value', 'placeholder', 'checked', 'disabled', 'readonly'],
      textarea: ['rows', 'cols', 'placeholder', 'disabled', 'readonly'],
      select: ['disabled'], option: ['value', 'selected']
    },
    allowedSchemes: ['https', 'data'],
    allowProtocolRelative: false,
    parser: { lowerCaseTags: true },
    transformTags: {
      img: (tagName, attributes) => ({
        tagName,
        attribs: isAllowedImageSource(attributes.src)
          ? attributes
          : Object.fromEntries(Object.entries(attributes).filter(([key]) => key !== 'src'))
      }),
      input: (tagName, attributes) => {
        const type = String(attributes.type || 'text').toLowerCase();
        return { tagName, attribs: { ...attributes, type: ['text', 'checkbox'].includes(type) ? type : 'text' } };
      }
    }
  });

  const $ = cheerio.load(markup, { xmlMode: false });
  $('script,iframe,object,embed,form,base,link,meta,svg,math,video,audio,source').remove();
  $('*').each((_index, element) => {
    const attrs = element.attribs || {};
    for (const name of Object.keys(attrs)) {
      if (/^on/iu.test(name) || ['srcdoc', 'formaction', 'action', 'href', 'xlink:href'].includes(name.toLowerCase())) {
        $(element).removeAttr(name);
      }
    }
    if (attrs.style) {
      const safeStyle = sanitizeCss(attrs.style, 'declarationList');
      if (safeStyle) $(element).attr('style', safeStyle);
      else $(element).removeAttr('style');
    }
  });
  $('style').each((_index, element) => {
    const safeCss = sanitizeCss($(element).html() || '');
    if (safeCss) $(element).text(safeCss);
    else $(element).remove();
  });

  if (!$('html').length || !$('body').length || !$('.worksheet-container').length) {
    throw invalidWorksheetHtml();
  }

  $('head').prepend(`<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`);
  const serialized = $.html().replace(/^\s*<!doctype html>\s*/iu, '');
  return `<!DOCTYPE html>\n${serialized}`;
}

module.exports = {
  MAX_WORKSHEET_HTML_BYTES,
  PREVIEW_CSP,
  sanitizeCss,
  sanitizeWorksheetHtml
};
