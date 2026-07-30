# Semantic performance benchmark

The semantic benchmark uses the same ordered global AI chain as production. It
does not select a semantic-specific provider or model.

Configuration:

```env
AI_PRIMARY_PROVIDER=google
AI_PRIMARY_MODEL=your-google-model
AI_FALLBACK_1_PROVIDER=openrouter
AI_FALLBACK_1_MODEL=your-first-openrouter-model
AI_FALLBACK_2_PROVIDER=openrouter
AI_FALLBACK_2_MODEL=your-second-openrouter-model
AI_FALLBACK_3_PROVIDER=openrouter
AI_FALLBACK_3_MODEL=your-third-openrouter-model
AI_ATTEMPT_TIMEOUT_MS=30000
AI_TOTAL_BUDGET_MS=120000
AI_RETRIES_PER_MODEL=0
AI_RETRY_DELAY_MS=1000
SEMANTIC_AI_MAX_OUTPUT_TOKENS=1800
```

Run the local structural benchmark (no provider request):

```bash
npm run benchmark:semantic
```

Live mode is explicit and must not be run without authorization:

```bash
npm run benchmark:semantic -- --live
```

Live output records the provider/model that actually succeeds. Prompts,
responses, credentials, and student data are not printed.
