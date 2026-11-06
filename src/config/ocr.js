'use strict';
const {mode}=require('../services/hybridSource/contract');

// Process environment is loaded by config/env.js at normal startup. No dotenv,
// provider client construction, network request or database access belongs here.
const invalid=()=>Object.assign(Error('OCR_SOURCE_CONFIGURATION_INVALID'),{code:'OCR_SOURCE_CONFIGURATION_INVALID'});
const missing=value=>typeof value!=='string'||!value.trim();
function validateOcrConfiguration(environment=process.env) {
  // In production the source mode and model are explicit: a missing variable must stop startup, not silently select a default
  // (the default mode is the legacy reader; the default model is a different, more expensive one).
  const production=environment.NODE_ENV==='production';
  if(production&&missing(environment.OCR_SOURCE_MODE))throw invalid();
  const selected=mode(environment);
  if(selected==='gpt_vision_exact'){
    if(production&&missing(environment.OCR_GPT_VISION_MODEL))throw invalid();
    const contract=require('../services/gptVisionExact/contract'),{model}=contract.config(environment);
    return {mode:selected,gptVisionModel:model,gptVisionReader:contract.readerMode(environment),gptVisionSecondReader:contract.secondReaderModel(environment)||'off',
      openrouterConfigured:true,teacherConfirmationRequired:false,sourceCallsPerPage:1};
  }
  if(selected==='astra_human_confirm'){
    if(environment.OCR_SOURCE_VERIFICATION_MODE&&!['first_pass'].includes(environment.OCR_SOURCE_VERIFICATION_MODE))throw Object.assign(Error('OCR_SOURCE_VERIFICATION_MODE_INVALID'),{code:'OCR_SOURCE_VERIFICATION_MODE_INVALID'});
    const models=require('../services/sourceFidelityOcr.service').config(environment);
    return {mode:selected,astraModel:models.astra,openrouterConfigured:true,teacherConfirmationRequired:true,transactionRequired:true};
  }
  require('../services/sourceFidelity/targetedVerification').enabled(environment);
  if(selected!=='astra_verified')return {mode:selected};
  const models=require('../services/sourceFidelityOcr.service').config(environment);
  require('../services/visionOcr.service').validateGoogleConfiguration(environment);
  return {mode:selected,astraModel:models.astra,fableModel:models.fable,
    openrouterConfigured:true,googleConfigured:true};
}
module.exports={validateOcrConfiguration};
