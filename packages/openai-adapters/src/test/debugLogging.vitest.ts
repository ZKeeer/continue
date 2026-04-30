import { describe, expect, it } from "vitest";

import {
  stringifyForLlmDebug,
  summarizeLlmRequestForDebug,
} from "../debugLogging.js";

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

  it("summarizes LLM request parameters without prompt text", () => {
    const output = stringifyForLlmDebug(
      summarizeLlmRequestForDebug({
        model: "debug-model",
        stream: true,
        max_tokens: 512,
        max_completion_tokens: 1024,
        reasoning_effort: "high",
        verbosity: "low",
        temperature: 0.2,
        top_p: 0.9,
        messages: [
          { role: "system", content: "system prompt should not be logged" },
          { role: "user", content: "user prompt should not be logged" },
        ],
      }),
    );

    expect(output).toContain('"model": "debug-model"');
    expect(output).toContain('"maxTokens": 512');
    expect(output).toContain('"maxCompletionTokens": 1024');
    expect(output).toContain('"reasoningEffort": "high"');
    expect(output).toContain('"verbosity": "low"');
    expect(output).toContain('"messageCount": 2');
    expect(output).toContain('"totalMessageTextLength": 66');
    expect(output).not.toContain("system prompt should not be logged");
    expect(output).not.toContain("user prompt should not be logged");
  });
});
