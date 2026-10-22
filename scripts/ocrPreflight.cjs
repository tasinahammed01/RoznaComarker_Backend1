'use strict';
try {
  // Same loader and process-over-file precedence as npm start; never connect DB.
  require('../src/config/env');
  const configuration=require('../src/config/ocr').validateOcrConfiguration();
  console.log(JSON.stringify({event:'ocr_preflight',...configuration,providerCalls:0,databaseWrites:0}));
} catch(error) {
  const safe=/^OCR_[A-Z0-9_]+$/.test(error?.code||'')?error.code:'OCR_PREFLIGHT_CONFIGURATION_INVALID';
  console.error(safe);process.exitCode=1;
}
