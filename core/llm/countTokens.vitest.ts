import { describe, expect, it } from "vitest";

import { estimateTokensFast } from "./countTokens";

describe("estimateTokensFast", () => {
  it("uses the updated 4.5 chars-per-token ratio for fast budgeting", () => {
    expect(estimateTokensFast("a".repeat(4500))).toBe(1000);
    expect(estimateTokensFast("a".repeat(9001))).toBe(2001);
  });
});
