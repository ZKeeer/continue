import { describe, expect, it } from "vitest";

import * as parameters from "./parameters";

describe("DEFAULT_AUTOCOMPLETE_OPTS", () => {
  it("uses the main-branch defaults for prompt budgeting", () => {
    expect(parameters.DEFAULT_AUTOCOMPLETE_OPTS.maxPromptTokens).toBe(4096);
    expect(parameters.DEFAULT_AUTOCOMPLETE_OPTS.prefixPercentage).toBe(0.4);
    expect(parameters.DEFAULT_AUTOCOMPLETE_OPTS.maxSuffixPercentage).toBe(0.2);
  });

  it("does not export zkdev-only presets", () => {
    expect("ZKDEV_SGLANG_QWEN3_A100_OPTS" in parameters).toBe(false);
  });
});
