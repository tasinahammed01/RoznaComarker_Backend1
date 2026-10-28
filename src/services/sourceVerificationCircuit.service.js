'use strict';
const Circuit = require('../models/SourceVerificationCircuit');
const { randomUUID } = require('crypto');
const { fail, config } = require('./gptVisionExact/contract');
const { classifyProviderHealth, isPaymentFailure, PAYMENT_COOLDOWN_MS } = require('./sourceVerificationPolicy');
const logger = require('../utils/logger');
const KEY = 'exact-source-v1';
const keyFor = model => `${KEY}:openrouter:${model}`;
async function enterCircuit(key, model) {
  let state;
  try { state = await Circuit.findOneAndUpdate({ _id: key }, { $setOnInsert: { failures: 0 } }, { upsert: true, returnDocument: 'after' }).lean(); }
  catch (error) { if (error.code !== 11000) throw error; state = await Circuit.findById(key).lean(); }
  if (state.blocked) throw fail('OCR_GPT_PROVIDER_CONFIGURATION_BLOCKED');
  if (!state.openUntil) return null;
  if (state.openUntil > new Date()) throw fail('OCR_GPT_CIRCUIT_OPEN');
  const owner = randomUUID();
  const claimed = await Circuit.findOneAndUpdate({ _id: key, blocked: { $ne: true }, openUntil: { $lte: new Date() },
    $or: [{ probeUntil: null }, { probeUntil: { $lte: new Date() } }] },
  { $set: { probeOwner: owner, probeUntil: new Date(Date.now() + 240000) } }, { returnDocument: 'after' });
  if (!claimed) throw fail('OCR_GPT_CIRCUIT_OPEN');
  logger.info({ event: 'source_verification_retry_probe', model, admitted: true });
  return owner;
}
async function finishCircuit(ticket, code, status) {
  if(code==='OCR_GPT_SOURCE_CANCELLED'){
    if(ticket.probe)await Circuit.updateOne({_id:ticket.key,probeOwner:ticket.probe},{$set:{probeOwner:null,probeUntil:new Date(0)}});
    return; // User cancellation is not evidence of provider failure or recovery.
  }
  const { probe: owner, key, model } = ticket;
  const kind = code ? classifyProviderHealth(code, status) : 'success';
  const filter = { _id: key, ...(owner ? { probeOwner: owner } : { openUntil: null }) };
  if (kind === 'success' || kind === 'image' || kind === 'source_evidence') {
    const result = await Circuit.updateOne(filter, { $set: { blocked: false, failures: 0, openUntil: null, probeOwner: null, probeUntil: null } });
    if (owner && result.matchedCount) logger.info({ event: 'source_verification_circuit_recovered', model, classification: kind });
  } else {
    const state = await Circuit.findOneAndUpdate(filter, { $inc: { failures: 1 } }, { returnDocument: 'after' });
    if (state && (state.failures >= 3 || owner || kind === 'operator')) {
      await Circuit.updateOne(filter, { $set: { blocked: kind === 'operator' && !isPaymentFailure(code), openUntil: new Date(Date.now() + PAYMENT_COOLDOWN_MS), probeOwner: null, probeUntil: null } });
      logger.warn({ event: 'source_verification_circuit_open', model, classification: kind, retryEligible: isPaymentFailure(code), httpStatus: status || null });
    }
  }
}
async function enter(model = config().model) {
  const key = keyFor(model), probe = await enterCircuit(key, model), owner = randomUUID();
  for (let slot = 0; slot < 4; slot++) {
    const id = `${KEY}:slot:${slot}`;
    try { await Circuit.updateOne({ _id: id }, { $setOnInsert: { probeUntil: new Date(0) } }, { upsert: true }); }
    catch (error) { if (error.code !== 11000) throw error; }
    const claimed = await Circuit.findOneAndUpdate({ _id: id, probeUntil: { $lte: new Date() } },
      { $set: { probeOwner: owner, probeUntil: new Date(Date.now() + 240000) } });
    if (claimed) return { probe, owner, id, key, model };
  }
  if (probe) await Circuit.updateOne({ _id: key, probeOwner: probe }, { $set: { probeUntil: new Date(0) } });
  throw fail('OCR_GPT_SOURCE_CHECKING');
}
async function finish(ticket, code, status) {
  try { if (ticket) await finishCircuit(ticket, code, status); }
  finally { if (ticket) await Circuit.updateOne({ _id: ticket.id, probeOwner: ticket.owner }, { $set: { probeUntil: new Date(0) } }); }
}
module.exports = { enter, finish, keyFor };
