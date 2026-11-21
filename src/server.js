const env = require("./config/env");
const connectDB = require("./config/db");
const logger = require("./utils/logger");
const { validateAIConfig } = require("./services/aiGeneration.service");
const pdfBrowserManager = require("./services/pdfBrowserManager.service");
const { runtimeContractFingerprint } = require("./services/runtimeContractFingerprint.service");
const { sanitizedAssessmentChain } = require("./services/aiGateway.service");


const app = require("./app");

let server;
let assessmentRecoveryWorker;
let teacherUploadEmailWorker;
let audioWorker;

const { createShutdown } = require('./services/shutdown.service');
const shutdown = createShutdown({ getServer: () => server,
  closeBrowser: () => pdfBrowserManager.closeBrowser(),
  stopBackground: () => { assessmentRecoveryWorker?.stop(); teacherUploadEmailWorker?.stop(); audioWorker?.stop(); },
  disconnect: () => require('mongoose').disconnect(), logger });

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled Rejection");
  logger.error(reason);
  shutdown("unhandledRejection", 1);
});

process.on("uncaughtException", (err) => {
  logger.error("Uncaught Exception");
  logger.error(err);
  shutdown("fatalError", 1);
});

async function start() {
  require('./services/aiGateway.service').getAssessmentAIConfig();
  const assessmentTiming=require('./services/assessmentExecutionPolicy.service').validateConfiguration();
  logger.info({event:'assessment_effective_configuration',...assessmentTiming.settings});
  if(assessmentTiming.errors.length)throw Object.assign(new Error('Unsafe assessment timing/output configuration: '+assessmentTiming.errors.join(',')),{code:'ASSESSMENT_CONFIGURATION_INVALID'});
  const ocrConfiguration = require('./config/ocr').validateOcrConfiguration();
  logger.info({ event: 'ocr_source_configuration', ...ocrConfiguration });
  await connectDB();
  if(ocrConfiguration.mode==='astra_human_confirm')await require('./services/sourceFidelity/transactionSupport').requireTransactions();
  if (['astra_verified','astra_human_confirm','gpt_vision_exact'].includes(ocrConfiguration.mode)) {
    // Normal connections disable autoIndex. Preserve the existing private
    // evidence TTL and receipt lookup indexes when opting into this mode.
    await require('./models/SourceFidelityEvidence').createIndexes();
    await require('./models/SourceFidelitySnapshot').createIndexes();
    if(ocrConfiguration.mode==='astra_human_confirm')await require('./models/SourceHumanReview').createIndexes();
  }
  require('./services/planEntitlementWorker.service').startPlanEntitlementWorker();
  const assessmentRecoveryEnabled = String(process.env.ASSESSMENT_RECOVERY_ENABLED || 'true').toLowerCase() !== 'false';
  if (assessmentRecoveryEnabled) {
    assessmentRecoveryWorker = require('./services/assessmentRecovery.service').startAssessmentRecoveryWorker();
  } else {
    logger.warn({ event: 'assessment_recovery_disabled' });
  }
  // Teacher-upload feedback emails run on their own timer, whatever the recovery setting (they never wait behind marking).
  teacherUploadEmailWorker = require('./services/teacherUploadEmail.service').startTeacherUploadEmailWorker();
  // One line to read in the PM2 log (values only, no secrets): whether background marking recovery and the email queue run.
  logger.info({ event: 'background_workers', assessmentRecoveryEnabled, teacherUploadEmailWorker: true,
    teacherUploadEmailIntervalMs: teacherUploadEmailWorker.intervalMs });
  // Reference files left waiting by a restart are read again (also on the next list or status request).
  if (require('./services/referenceFiles/policy').referenceFilesEnabled()) void require('./services/referenceFiles/referenceFile.service').resumeInBackground();
  // Audio transcription jobs (AUDIO_STT_ENABLED, default off): null while off, so nothing starts.
  audioWorker = require('./services/audio/processing').startAudioWorkerIfEnabled();
  // The speaking assessor's own contract (not part of the runtime contract fingerprint): one line, versions only.
  { const speakingPrompt = require('./services/audio/speakingAssessmentPrompt'); logger.info({ event: 'speaking_assessment_contract', promptVersion: speakingPrompt.PROMPT_VERSION, schemaVersion: speakingPrompt.SCHEMA_VERSION }); }
  const pdfEngine = String(process.env.PDF_REPORT_ENGINE || "puppeteer").toLowerCase();
  if (pdfEngine !== "puppeteer") throw new Error("Unsupported PDF_REPORT_ENGINE configuration.");
  pdfBrowserManager.validateBrowserRuntime();

  // Validate AI provider configuration
  const aiConfigValidation = validateAIConfig();
  if (!aiConfigValidation.isValid) {
    throw new Error(
      "AI configuration validation failed. Check server logs for details.",
    );
  }

  // Debug: Check Unsplash configuration
  if (process.env.UNSPLASH_ACCESS_KEY) {
    logger.info("Unsplash configured: true");
  } else {
    logger.warn("Unsplash configured: false (UNSPLASH_ACCESS_KEY not set)");
  }

  // ─── AI API Key Health Check ────────────────────────────────────────
  logger.info(`Global AI chain configured: ${aiConfigValidation.isValid}`);
  logger.info({
    message: "Resolved global AI chain",
    configured: aiConfigValidation.isValid,
    models: aiConfigValidation.chain.map((entry, index) => ({
      index,
      role: index === 0 ? "primary" : `fallback_${index}`,
      provider: entry.provider,
      model: entry.model,
    })),
  });
  logger.info({
    message: "Resolved assessment AI chain",
    models: sanitizedAssessmentChain(process.env),
  });

  if (!process.env.GROQ_API_KEY) {
    logger.warn(
      "⚠️  WARNING: GROQ_API_KEY is not set. Groq fallback will not work when Gemini is rate limited.",
    );
  } else {
    logger.info("Groq API key configured: true");
  }

  const port = process.env.PORT || env.PORT || 5000;
  // Production traffic must enter through the single trusted Nginx hop. Keep
  // development reachable on the LAN unless HOST is explicitly configured.
  const host = process.env.HOST || (env.NODE_ENV === "production" ? "127.0.0.1" : "0.0.0.0");
  server = app.listen(port, host, () => {
    logger.info(`Server running on ${host}:${port} (${env.NODE_ENV})`);
    logger.metric({ event: "runtime_contract_fingerprint", ...runtimeContractFingerprint() });
  });
}

start().catch((err) => {
  logger.error("Startup failed");
  logger.error(err);
  process.exit(1);
});
