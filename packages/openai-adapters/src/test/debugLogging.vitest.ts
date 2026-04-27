import { describe, expect, it } from "vitest";

import { stringifyForLlmDebug } from "../debugLogging.js";

describe("stringifyForLlmDebug", () => {
  it("truncates long request text while preserving request parameters", () => {
    const longPrompt = "x".repeat(3_000);

    const output = stringifyForLlmDebug({
      model: "debug-model",
      temperature: 0.2,
      reasoning: { effort: "high" },
      body: {
        messages: [{ role: "user", content: longPrompt }],
      },
    });

    expect(output).toContain('"model": "debug-model"');
    expect(output).toContain('"temperature": 0.2');
    expect(output).toContain('"effort": "high"');
    expect(output).toContain("<truncated 2500 chars>");
    expect(output).not.toContain(longPrompt);
  });
});