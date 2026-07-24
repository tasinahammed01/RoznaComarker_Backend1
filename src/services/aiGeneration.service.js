const OpenAI = require("openai");

// ─────────────────────────────────────────────────────────────────────────────
// AI GENERATION SERVICE
// ─────────────────────────────────────────────────────────────────────────────
/**
 * AI generation service supporting OpenAI and OpenRouter providers.
 * Provides unified interface for chat completions across different AI providers.
 * Includes retry mechanism, timeout handling, and comprehensive error handling.
 */

const AI_PROVIDER = process.env.PRIMARY_AI_PROVIDER || "openrouter";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENROUTER_MODEL =
  process.env.PRIMARY_AI_MODEL || "openai/gpt-oss-120b";
const OPENROUTER_BASE_URL =
  process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
const OPENROUTER_TIMEOUT_MS =
  parseInt(process.env.OPENROUTER_TIMEOUT_MS) || 60000;
const MAX_RETRIES = parseInt(process.env.AI_MAX_RETRIES) || 3;
const RETRY_DELAY_MS = parseInt(process.env.AI_RETRY_DELAY_MS) || 1000;

const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || '').trim();

const GEMINI_BASE_URL =
  process.env.GEMINI_BASE_URL ||
  'https://generativelanguage.googleapis.com/v1';

const GEMINI_TIMEOUT_MS =
  Number(process.env.GEMINI_TIMEOUT_MS) || 60000;

console.log("[AI GENERATION] Provider:", AI_PROVIDER);
console.log("[AI GENERATION] OpenAI model:", OPENAI_MODEL);
console.log("[AI GENERATION] OpenRouter model:", OPENROUTER_MODEL);
console.log("[AI GENERATION] Max retries:", MAX_RETRIES);
console.log("[AI GENERATION] Retry delay:", RETRY_DELAY_MS, "ms");

// OpenAI client (for OpenAI provider)
let openaiClient = null;
if (process.env.OPENAI_API_KEY) {
  openaiClient = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: OPENROUTER_TIMEOUT_MS,
  });
}

/**
 * Sleep utility for retry delays
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generate chat completion using OpenRouter API with retry mechanism
 * @param {Array} messages - Array of message objects with role and content
 * @param {Object} options - Additional options (temperature, max_tokens, etc.)
 * @returns {Promise<string>} Generated content
 */
async function generateWithOpenRouter(messages, options = {}) {
  const {
    temperature = 0.4,
    max_tokens = 8000,
    response_format = null,
  } = options;
  const model = typeof options.model === 'string' && options.model.trim() ? options.model.trim() : OPENROUTER_MODEL;

  const requestBody = {
    model,
    messages,
    temperature,
    max_tokens,
  };

  // Add response_format if specified (for structured JSON output)
  if (response_format) {
    requestBody.response_format = response_format;
  }

  let lastError = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      if (typeof options.onAttempt === 'function') await options.onAttempt({ attempt: attempt + 1, maxAttempts: MAX_RETRIES });
      console.log(
        `[AI GENERATION] OpenRouter attempt ${attempt + 1}/${MAX_RETRIES} with model: ${model}`,
      );

      const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.FRONTEND_URL || "http://localhost:4200",
          "X-Title": "RoznaComarker",
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS),
      });

      if (!response.ok) {
        await response.text();
        console.error(
          `[AI GENERATION] OpenRouter attempt ${attempt + 1} failed (${response.status})`,
        );

        // Don't retry on authentication or invalid request errors
        if (response.status !== 429 && response.status < 500) {
          throw new Error(
            `OpenRouter API error (${response.status})`,
          );
        }

        // Retry on rate limit, server errors, or timeout
        lastError = new Error(
          `OpenRouter API error (${response.status})`,
        );
        if (attempt < MAX_RETRIES - 1) {
          if (typeof options.onRetry === 'function') await options.onRetry({ attempt: attempt + 1, maxAttempts: MAX_RETRIES, delayMs: RETRY_DELAY_MS, code: `HTTP_${response.status}` });
          console.log(`[AI GENERATION] Retrying in ${RETRY_DELAY_MS}ms...`);
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        throw lastError;
      }

      const data = await response.json();

      // Normalize response to match OpenAI format
      const content = data.choices?.[0]?.message?.content || "";
      if (typeof options.onResponse === 'function') await options.onResponse({
        usage: data.usage || null,
        model: data.model || model,
        provider: 'openrouter'
      });
      console.log(
        "[AI GENERATION] OpenRouter response length:",
        content.length,
      );

      return content;
    } catch (error) {
      lastError = error;

      // Don't retry on AbortError (timeout) if it's the last attempt
      if (error.name === "AbortError" || error.name === "TimeoutError" || error.code === "ETIMEDOUT" || error.code === 23) {
        console.error(
          `[AI GENERATION] OpenRouter attempt ${attempt + 1} timed out`,
        );
        if (attempt < MAX_RETRIES - 1) {
          if (typeof options.onRetry === 'function') await options.onRetry({ attempt: attempt + 1, maxAttempts: MAX_RETRIES, delayMs: RETRY_DELAY_MS, code: 'AI_PROVIDER_TIMEOUT' });
          console.log(`[AI GENERATION] Retrying in ${RETRY_DELAY_MS}ms...`);
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        throw new Error("OpenRouter request timed out after multiple retries");
      }

      // Retry on network errors
      if (
        error.code === "ECONNRESET" ||
        error.code === "ENOTFOUND" ||
        error.code === "ECONNREFUSED"
      ) {
        console.error(
          `[AI GENERATION] OpenRouter attempt ${attempt + 1} network error:`,
          error.code,
        );
        if (attempt < MAX_RETRIES - 1) {
          if (typeof options.onRetry === 'function') await options.onRetry({ attempt: attempt + 1, maxAttempts: MAX_RETRIES, delayMs: RETRY_DELAY_MS, code: 'AI_PROVIDER_NETWORK' });
          console.log(`[AI GENERATION] Retrying in ${RETRY_DELAY_MS}ms...`);
          await sleep(RETRY_DELAY_MS);
          continue;
        }
      }

      // Don't retry on other errors
      throw error;
    }
  }

  throw (
    lastError || new Error("OpenRouter generation failed after all retries")
  );
}

/**
 * Generate chat completion using OpenAI API with retry mechanism
 * @param {Array} messages - Array of message objects with role and content
 * @param {Object} options - Additional options (temperature, max_tokens, etc.)
 * @returns {Promise<string>} Generated content
 */
async function generateWithOpenAI(messages, options = {}) {
  const {
    temperature = 0.4,
    max_tokens = 8000,
    response_format = null,
  } = options;
  const model = typeof options.model === 'string' && options.model.trim() ? options.model.trim() : OPENAI_MODEL;

  if (!openaiClient) {
    throw new Error("OpenAI client not initialized. Check OPENAI_API_KEY.");
  }

  let lastError = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      if (typeof options.onAttempt === 'function') await options.onAttempt({ attempt: attempt + 1, maxAttempts: MAX_RETRIES });
      console.log(
        `[AI GENERATION] OpenAI attempt ${attempt + 1}/${MAX_RETRIES} with model: ${model}`,
      );

      const completion = await openaiClient.chat.completions.create({
        model,
        messages,
        temperature,
        max_tokens,
        response_format,
      });

      const content = completion.choices?.[0]?.message?.content || "";
      if (typeof options.onResponse === 'function') await options.onResponse({
        usage: completion.usage || null,
        model: completion.model || model,
        provider: 'openai'
      });
      console.log("[AI GENERATION] OpenAI response length:", content.length);

      return content;
    } catch (error) {
      lastError = error;

      // Don't retry on authentication or invalid request errors
      if (error.status === 401 || error.status === 400) {
        throw error;
      }

      // Retry on rate limit, server errors, or timeout
      if (attempt < MAX_RETRIES - 1) {
        if (typeof options.onRetry === 'function') await options.onRetry({ attempt: attempt + 1, maxAttempts: MAX_RETRIES, delayMs: RETRY_DELAY_MS, code: error.code || `HTTP_${error.status || 'UNKNOWN'}` });
        console.log(`[AI GENERATION] Retrying in ${RETRY_DELAY_MS}ms...`);
        await sleep(RETRY_DELAY_MS);
        continue;
      }

      throw error;
    }
  }

  throw lastError || new Error("OpenAI generation failed after all retries");
}

async function generateWithGemini(messages, options = {}) {
  if (!GEMINI_API_KEY) {
    const error = new Error('GEMINI_API_KEY is not configured');
    error.code = 'AI_PROVIDER_NOT_CONFIGURED';
    throw error;
  }

  const model = String(
    options.model ||
    process.env.ADAPTIVE_PRACTICE_MODEL ||
    'gemini-3.6-flash'
  ).trim();

  const maxOutputTokens =
    Number(options.max_tokens) ||
    Number(options.maxOutputTokens) ||
    4000;

  const temperature =
    Number.isFinite(Number(options.temperature))
      ? Number(options.temperature)
      : 0.2;

  const systemMessages = messages
    .filter((message) => message.role === 'system')
    .map((message) => String(message.content || ''))
    .filter(Boolean);

  const conversationMessages = messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [
        {
          text:
            typeof message.content === 'string'
              ? message.content
              : JSON.stringify(message.content)
        }
      ]
    }));

  const body = {
    contents: conversationMessages,
    generationConfig: {
      temperature,
      maxOutputTokens
    }
  };

  if (systemMessages.length > 0) {
    body.systemInstruction = {
      parts: [
        {
          text: systemMessages.join('\n\n')
        }
      ]
    };
  }

  const controller = new AbortController();

  const timeoutMs =
    Number(process.env.ADAPTIVE_PRACTICE_AI_TIMEOUT_MS) ||
    GEMINI_TIMEOUT_MS;

  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    if (typeof options.onAttempt === 'function') {
      options.onAttempt({
        attempt: 1,
        provider: 'google',
        model
      });
    }

    console.log(
      `[AI GENERATION] Gemini attempt 1 with model: ${model}`
    );

    const response = await fetch(
      `${GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: controller.signal
      }
    );

    const responseText = await response.text();

    let data;

    try {
      data = responseText
        ? JSON.parse(responseText)
        : {};
    } catch {
      data = {};
    }

    if (!response.ok) {
      const providerMessage =
        data?.error?.message ||
        responseText ||
        `Gemini API error (${response.status})`;

      console.error(
        '[AI GENERATION] Gemini request failed',
        {
          status: response.status,
          model,
          message: providerMessage
        }
      );

      const error = new Error(providerMessage);
      error.status = response.status;

      if (response.status === 401 || response.status === 403) {
        error.code = 'AI_PROVIDER_AUTH_ERROR';
      } else if (response.status === 429) {
        error.code = 'AI_PROVIDER_RATE_LIMIT';
      } else if (response.status >= 500) {
        error.code = 'AI_PROVIDER_UNAVAILABLE';
      } else {
        error.code = `AI_PROVIDER_HTTP_${response.status}`;
      }

      throw error;
    }

    const content = data?.candidates?.[0]?.content?.parts
      ?.map((part) => part?.text || '')
      .join('')
      .trim();

    if (!content) {
      const error = new Error(
        'Gemini returned an empty response'
      );
      error.code = 'AI_INVALID_RESPONSE';
      throw error;
    }

    if (typeof options.onResponse === 'function') {
      options.onResponse({
        provider: 'google',
        model,
        usage: data?.usageMetadata || null
      });
    }

    console.log(
      `[AI GENERATION] Gemini generation successful with model: ${model}`
    );

    return content;
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error(
        `Gemini request timed out after ${timeoutMs}ms`
      );

      timeoutError.code = 'AI_PROVIDER_TIMEOUT';

      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Generate chat completion using configured AI provider
 * @param {Array} messages - Array of message objects with role and content
 * @param {Object} options - Additional options (temperature, max_tokens, etc.)
 * @returns {Promise<string>} Generated content
 */
async function generateChatCompletion(messages, options = {}) {
  const provider = String(
    options.provider || AI_PROVIDER || 'openrouter'
  ).trim().toLowerCase();

  try {
    if (provider === 'google') {
      return await generateWithGemini(messages, options);
    }

    if (provider === 'openai') {
      return await generateWithOpenAI(messages, options);
    }

    if (provider === 'openrouter') {
      return await generateWithOpenRouter(messages, options);
    }

    const error = new Error(
      `Unsupported AI provider: ${provider}`
    );

    error.code = 'AI_PROVIDER_UNSUPPORTED';

    throw error;
  } catch (error) {
    console.error(
      '[AI GENERATION] Request failed',
      {
        provider,
        model: options.model || null,
        code: error.code || null,
        status:
          error.status ||
          error.response?.status ||
          null
      }
    );

    throw error;
  }
}

/**
 * Validate AI configuration on server startup
 * @returns {Object} Validation result with isValid flag and warnings
 */
function validateAIConfig() {
  const warnings = [];
  const errors = [];

  console.log("[AI CONFIG] Validating AI provider configuration...");

  // Validate provider
  if (!["openai", "openrouter"].includes(AI_PROVIDER)) {
    errors.push(
      `Invalid AI_PROVIDER: ${AI_PROVIDER}. Must be 'openai' or 'openrouter'.`,
    );
  }

  // Validate OpenAI config
  if (AI_PROVIDER === "openai") {
    if (!process.env.OPENAI_API_KEY) {
      errors.push("OPENAI_API_KEY is required when AI_PROVIDER=openai");
    }
    if (!OPENAI_MODEL) {
      warnings.push("OPENAI_MODEL not set, using default: gpt-4o-mini");
    }
  }

  // Validate OpenRouter config
  if (AI_PROVIDER === "openrouter") {
    if (!process.env.OPENROUTER_API_KEY) {
      errors.push("OPENROUTER_API_KEY is required when AI_PROVIDER=openrouter");
    }
    if (!OPENROUTER_MODEL) {
      warnings.push(
        "PRIMARY_AI_MODEL not set, using default: openai/gpt-oss-120b",
      );
    }
    if (!OPENROUTER_BASE_URL) {
      warnings.push(
        "OPENROUTER_BASE_URL not set, using default: https://openrouter.ai/api/v1",
      );
    }
  }

  // Validate timeout config
  if (OPENROUTER_TIMEOUT_MS < 5000) {
    warnings.push(
      `OPENROUTER_TIMEOUT_MS is very low (${OPENROUTER_TIMEOUT_MS}ms). Consider increasing to at least 10000ms.`,
    );
  }

  // Validate retry config
  if (MAX_RETRIES < 1) {
    warnings.push(
      `AI_MAX_RETRIES is less than 1 (${MAX_RETRIES}). Retry mechanism disabled.`,
    );
  }
  if (RETRY_DELAY_MS < 500) {
    warnings.push(
      `AI_RETRY_DELAY_MS is very low (${RETRY_DELAY_MS}ms). Consider increasing to at least 1000ms.`,
    );
  }

  // Log results
  if (errors.length > 0) {
    console.error("[AI CONFIG] Configuration errors:");
    errors.forEach((err) => console.error("  -", err));
  }

  if (warnings.length > 0) {
    console.warn("[AI CONFIG] Configuration warnings:");
    warnings.forEach((warn) => console.warn("  -", warn));
  }

  if (errors.length === 0 && warnings.length === 0) {
    console.log("[AI CONFIG] Configuration is valid");
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

function getAIConfigStatus() {
  const provider = String(AI_PROVIDER || '').toLowerCase();
  const providerConfigured = provider === 'openai' || provider === 'openrouter';
  const modelConfigured = provider === 'openai' ? Boolean(OPENAI_MODEL) : provider === 'openrouter' ? Boolean(OPENROUTER_MODEL) : false;
  const credentialConfigured = provider === 'openai'
    ? Boolean(String(process.env.OPENAI_API_KEY || '').trim())
    : provider === 'openrouter' ? Boolean(String(process.env.OPENROUTER_API_KEY || '').trim()) : false;
  return { providerConfigured, modelConfigured, credentialConfigured, configured: providerConfigured && modelConfigured && credentialConfigured };
}

module.exports = {
  generateChatCompletion,
  generateWithOpenRouter,
  generateWithOpenAI,
  generateWithGemini,
  validateAIConfig,
  AI_PROVIDER,
  OPENAI_MODEL,
  OPENROUTER_MODEL,
  getAIConfigStatus,
};
