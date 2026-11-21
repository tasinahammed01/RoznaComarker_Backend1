'use strict';
// OpenRouter /audio/transcriptions error bodies seen live on 2026-11-17 (bodies only; no ids or headers). The 404 data-policy body came from a
// model without a zero-data-retention endpoint (x-ai/grok-stt-2.0) with provider.zdr=true: the same routing step refuses any such model.
// The 402 came with "Retry-After: 120". A 429 was not reproduced (20 concurrent requests); its shape below is the documented one.
module.exports = {
  "badAudio400": {
    "error": {
      "message": "Provider could not process the audio input (unsupported or malformed audio)",
      "code": 400
    }
  },
  "tooLarge400": {
    "error": {
      "message": "Audio file exceeds the 25 MB multipart upload limit. OpenAI and Groq models accept larger audio as base64 JSON via input_audio; providers that support URL input accept a source_url field instead of a file; other providers are limited to this size.",
      "code": 400
    }
  },
  "dataPolicy404": {
    "error": {
      "message": "No endpoints found matching your data policy (Zero data retention). Configure: https://openrouter.ai/settings/privacy",
      "code": 404,
      "metadata": {
        "routing_funnel": [
          {
            "step": "Initial Endpoints",
            "endpoint_count": 1
          }
        ],
        "failed_routing_step": "Filter by Data Policy"
      }
    }
  },
  "inFlightBudget402": {
    "error": {
      "message": "This request would exceed your available credits given your current in-flight requests. Retry after in-flight requests settle, or add credits.",
      "code": 402,
      "metadata": {
        "reason": "in_flight_budget_exhausted",
        "limit_source": "openrouter_in_flight_budget",
        "remedy_hint": "Retry after your in-flight requests settle (see the Retry-After header). Adding credits at https://openrouter.ai/settings/credits raises your in-flight budget, up to a capped ceiling.",
        "headers": {
          "Retry-After": "120"
        }
      }
    }
  },
  "rateLimited429": {
    "error": {
      "code": 429,
      "message": "Rate limit exceeded"
    }
  }
};
