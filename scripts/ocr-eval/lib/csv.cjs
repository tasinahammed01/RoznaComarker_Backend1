'use strict';
/** RFC 4180 reader for the harness's own results.csv: quoted fields, doubled quotes, embedded line breaks, CRLF or LF. */
function parseCsv(text) {
  const records = [];
  let field = '', record = [], quoted = false;
  const source = String(text).replace(/^﻿/, '');
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { record.push(field); field = ''; }
    else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && source[i + 1] === '\n') i++;
      record.push(field); records.push(record); record = []; field = '';
    } else field += ch;
  }
  if (field !== '' || record.length) { record.push(field); records.push(record); }
  const [header, ...data] = records.filter(r => !(r.length === 1 && r[0] === ''));
  if (!header) return [];
  return data.map(r => Object.fromEntries(header.map((name, k) => [name, r[k] ?? ''])));
}

module.exports = { parseCsv };
