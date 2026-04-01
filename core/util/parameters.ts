import { TabAutocompleteOptions } from "../index.js";

export const DEFAULT_AUTOCOMPLETE_OPTS: TabAutocompleteOptions = {
  disable: false,
  maxPromptTokens: 4096,
  prefixPercentage: 0.3,
  maxSuffixPercentage: 0.2,
  debounceDelay: 350,
  modelTimeout: 150,
  multilineCompletions: "auto",
  // @deprecated TO BE REMOVED
  slidingWindowPrefixPercentage: 0.75,
  // @deprecated TO BE REMOVED
  slidingWindowSize: 500,
  useCache: true,
  onlyMyCode: true,
  useRecentlyEdited: true,
  useRecentlyOpened: true,
  disableInFiles: undefined,
  useImports: true,
  transform: true,
  showWhateverWeHaveAtXMs: 300,
  // Experimental options: true = enabled, false = disabled, number = enabled w priority
  experimental_includeClipboard: false,
  experimental_includeRecentlyVisitedRanges: true,
  experimental_includeRecentlyEditedRanges: true,
  experimental_includeDiff: true,
  experimental_enableStaticContextualization: false,
  // [zkdev] Experiment flags for prediction features — default off
  experimental_enablePrefetch: false,
  experimental_enableEditIntentDetection: false,
  experimental_enableSimilarEditDetection: false,
};

/**
 * [zkdev] Optimized preset for: sglang + qwen3-coder-30b-a3b-instruct + A100
 * Apply via tabAutocompleteOptions in config.json:
 *   "tabAutocompleteOptions": { ...ZKDEV_SGLANG_QWEN3_A100_OPTS }
 */
export const ZKDEV_SGLANG_QWEN3_A100_OPTS: Partial<TabAutocompleteOptions> = {
  maxPromptTokens: 8192,
  prefixPercentage: 0.45,
  maxSuffixPercentage: 0.25,
  debounceDelay: 120,
  modelTimeout: 300,
  showWhateverWeHaveAtXMs: 500,
  experimental_enableStaticContextualization: true,
  experimental_enablePrefetch: true,
  experimental_enableEditIntentDetection: true,
  experimental_enableSimilarEditDetection: true,
};

export const COUNT_COMPLETION_REJECTED_AFTER = 10_000;
export const DO_NOT_COUNT_REJECTED_BEFORE = 250;

export const RETRIEVAL_PARAMS = {
  rerankThreshold: 0.3,
  nFinal: 20,
  nRetrieve: 50,
  bm25Threshold: -2.5,
  nResultsToExpandWithEmbeddings: 5,
  nEmbeddingsExpandTo: 5,
};
