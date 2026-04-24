const DEFAULT_CONTEXT_LENGTH = 128 * 1024;
const DEFAULT_MAX_TOKENS = Math.floor(DEFAULT_CONTEXT_LENGTH * 0.35);
const DEFAULT_TEMPERATURE = 0.5;
const DEFAULT_PRUNING_LENGTH = DEFAULT_CONTEXT_LENGTH;
const DEFAULT_REASONING_TOKENS = Math.floor(DEFAULT_CONTEXT_LENGTH * 0.5);

const DEFAULT_ARGS = {
  maxTokens: DEFAULT_MAX_TOKENS,
  temperature: DEFAULT_TEMPERATURE,
};

const PROXY_URL = "http://localhost:65433";

const DEFAULT_MAX_CHUNK_SIZE = 500; // 512 - buffer for safety (in case of differing tokenizers)
const DEFAULT_MAX_BATCH_SIZE = 64;

export enum LLMConfigurationStatuses {
  VALID = "valid",
  MISSING_API_KEY = "missing-api-key",
  MISSING_ENV_SECRET = "missing-env-secret",
}

export enum NEXT_EDIT_MODELS {
  MERCURY_CODER = "mercury-coder",
  INSTINCT = "instinct",
}

export {
  DEFAULT_ARGS,
  DEFAULT_CONTEXT_LENGTH,
  DEFAULT_MAX_BATCH_SIZE,
  DEFAULT_MAX_CHUNK_SIZE,
  DEFAULT_MAX_TOKENS,
  DEFAULT_PRUNING_LENGTH,
  DEFAULT_REASONING_TOKENS,
  PROXY_URL,
};
