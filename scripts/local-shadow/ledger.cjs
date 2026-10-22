'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const kinds = new Set(['upload', 'orientation', 'document', 'shadow', 'shadow-http', 'google-orientation-http', 'google-document-http', 'google-auth-1', 'google-auth-2']);
function durable(file, data, flag = 'wx') {
  const fd = fs.openSync(file, flag, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(data) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
class Ledger {
  constructor(directory) {
    this.directory = directory; fs.mkdirSync(directory, { recursive: true });
    const manifest = path.join(directory, 'run.json');
    try { durable(manifest, { runId: crypto.randomUUID(), createdAt: new Date().toISOString() }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    this.run = JSON.parse(fs.readFileSync(manifest));
  }
  spent(kind) { if (!kinds.has(kind)) throw Error('INVALID_BUDGET_KIND'); return fs.existsSync(path.join(this.directory, kind + '.reserved.json')); }
  reserve(kind, hash) {
    if (!kinds.has(kind)) throw Error('INVALID_BUDGET_KIND');
    if (hash && !/^[a-f0-9]{64}$/.test(hash)) throw Error('INVALID_IMAGE_HASH');
    try { durable(path.join(this.directory, kind + '.reserved.json'), { runId: this.run.runId, attempt: 1, kind,
      imageHash: hash || null, timestamp: new Date().toISOString() }); } catch (e) { if (e.code === 'EEXIST') throw Error('ONE_SHOT_BUDGET_CONSUMED'); throw e; }
    this.event('RESERVED', { kind, imageHash: hash });
  }
  event(event, fields = {}) {
    // Explicit projection: arbitrary errors, credentials, prompts, images and headers cannot be serialized.
    const safe = {};
    for (const key of ['kind', 'imageHash', 'httpStatus', 'latencyMs', 'promptTokens', 'completionTokens', 'totalTokens', 'providerCost', 'finishReason', 'provider', 'model']) {
      const value = fields[key];
      if (['httpStatus','latencyMs','promptTokens','completionTokens','totalTokens','providerCost'].includes(key)) {
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) safe[key] = value;
      } else if (key === 'finishReason') {
        if (['stop','length','content_filter','tool_calls','error'].includes(value)) safe[key] = value;
      } else if (key === 'provider' && ['openrouter','google_vision'].includes(value)) safe[key] = value;
      else if (key === 'model' && value === 'openai/gpt-4.1-mini') safe[key] = value;
      else if (key === 'kind' && kinds.has(value)) safe[key] = value;
      else if (key === 'imageHash' && /^[a-f0-9]{64}$/.test(value || '')) safe[key] = value;
    }
    durable(path.join(this.directory, 'events.jsonl'), { runId: this.run.runId, event, timestamp: new Date().toISOString(), ...safe }, 'a');
  }
  auth(hash) { this.reserve(this.spent('google-auth-1') ? 'google-auth-2' : 'google-auth-1', hash); }
}
module.exports = { Ledger };
