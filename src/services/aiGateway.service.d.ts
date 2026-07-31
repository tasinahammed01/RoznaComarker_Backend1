export interface GatewayResult<T = unknown> {
  value: T;
  content: string;
  provider: string;
  model: string;
  attemptCount: number;
  fallbackIndex: number;
  fallbackUsed: boolean;
  durationMs: number;
  usage: Record<string, number> | null;
  attempts: Array<Record<string, unknown>>;
  metadata: Record<string, unknown>;
}

export function generate<T = unknown>(options: {
  feature?: string;
  messages: Array<Record<string, unknown>>;
  maxOutputTokens?: number;
  temperature?: number;
  responseFormat?: "json" | "text";
  googleThinkingLevel?: "minimal" | "low" | "medium" | "high";
  validate?: (content: string, provider: Record<string, string>) => T | Promise<T>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleepFn?: (milliseconds: number) => Promise<void>;
  randomFn?: () => number;
  config?: Record<string, unknown>;
  onAttempt?: (attempt: Record<string, unknown>) => void | Promise<void>;
  onRetry?: (retry: Record<string, unknown>) => void | Promise<void>;
}): Promise<GatewayResult<T>>;

export function getAIConfig(env?: NodeJS.ProcessEnv): Record<string, unknown>;
export function validateAIConfig(env?: NodeJS.ProcessEnv): {
  isValid: boolean;
  errors: string[];
  warnings: string[];
};
