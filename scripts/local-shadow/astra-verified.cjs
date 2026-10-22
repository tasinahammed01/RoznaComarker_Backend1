'use strict';
const fs=require('fs'),path=require('path');
const {root}=require('./config.cjs');
function inspect() {
  const parsed=require('dotenv').parse(fs.readFileSync(path.join(root,'.env')));
  // Only these explicit overrides may cross into the isolated process.
  const names=['OCR_ASTRA_MODEL','OCR_FABLE_MODEL','OPENROUTER_API_KEY','GOOGLE_CLOUD_KEY_FILE','GOOGLE_APPLICATION_CREDENTIALS'];
  const selected=Object.fromEntries(names.filter(k=>process.env[k]||parsed[k]).map(k=>[k,process.env[k]||parsed[k]]));
  const models=require('../../src/services/sourceFidelityOcr.service').config(selected);
  const secret=require('./real-preflight.cjs').credentials(selected);
  return {env:{OCR_ASTRA_MODEL:models.astra,OCR_FABLE_MODEL:models.fable,OPENROUTER_API_KEY:secret.openrouterKey,
    GOOGLE_APPLICATION_CREDENTIALS:secret.googlePath,GOOGLE_CLOUD_KEY_FILE:secret.googlePath},
    summary:{status:'ASTRA_VERIFIED_PREFLIGHT_PASS',models,googleCredentialsPresent:true,openrouterKeyPresent:true,
      generationCalls:0,hosts:['vision.googleapis.com','oauth2.googleapis.com','openrouter.ai'],
      mongo:'127.0.0.1:27028/rozna_shadow_local',uploads:'.local-shadow/uploads'}};
}
function install() {
  const network=require('./network.cjs');
  const gateway=require('../../src/services/aiGateway.service');
  const attempt=gateway.providerAttempt;
  gateway.providerAttempt=(options)=>network.scope('shadow','source',()=>attempt(options));
  // Gateway.generate closes over providerAttempt, so scope normal assessments too without changing bodies/retries.
  const generate=gateway.generate;
  gateway.generate=(options)=>network.scope('shadow','assessment',()=>generate(options));
  const vision=require('../../src/services/visionOcr.service');
  for(const name of ['extractOcrFromImageFile','detectOrientationAnnotation']) {
    const fn=vision[name];vision[name]=(...args)=>network.scope('google','document',()=>fn(...args));
  }
  return {stop:()=>network.disable()};
}
module.exports={inspect,install};
