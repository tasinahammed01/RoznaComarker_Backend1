'use strict';
const {mode}=require('../services/hybridSource/contract');

// Process environment is loaded by config/env.js at normal startup. No dotenv,
// provider client construction, network request or database access belongs here.
function validateOcrConfiguration(environment=process.env) {
  const selected=mode(environment);
  if(selected==='gpt_vision_exact'){
    const {model}=require('../services/gptVisionExact/contract').config(environment);
    return {mode:selected,gptVisionModel:model,openrouterConfigured:true,teacherConfirmationRequired:false,sourceCallsPerPage:1};
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
