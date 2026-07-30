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
  validate?: (content: string) => T;
}): Promise<GatewayResult<T>>;

export function getAIConfig(env?: NodeJS.ProcessEnv): Record<string, unknown>;
export function validateAIConfig(env?: NodeJS.ProcessEnv): {
  isValid: boolean;
  errors: string[];
  warnings: string[];
};
