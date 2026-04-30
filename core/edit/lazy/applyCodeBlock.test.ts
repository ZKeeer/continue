import { DiffLine, ILLM } from "../..";
import { applyCodeBlock } from "./applyCodeBlock";

class ThrowingApplyLLM {
  model = "claude-3-5-sonnet-20241022";
  providerName = "anthropic";
  underlyingProviderName = "anthropic";

  async *streamChat(): AsyncGenerator<any> {
    throw new Error("LLM apply should not be used for unified diff input");
  }
}

async function collectDiffLines(
  generator: AsyncGenerator<DiffLine>,
): Promise<DiffLine[]> {
  const lines: DiffLine[] = [];
  for await (const line of generator) {
    lines.push(line);
  }
  return lines;
}

describe("applyCodeBlock", () => {
  it("applies unified diffs before full-file lazy rewrite handling", async () => {
    const oldFile = ["function value() {", "  return 1;", "}"].join("\n");
    const unifiedDiff = [
      "@@ -1,3 +1,3 @@",
      " function value() {",
      "-  return 1;",
      "+  return 2;",
      " }",
    ].join("\n");

    const { isInstantApply, diffLinesGenerator } = await applyCodeBlock(
      oldFile,
      unifiedDiff,
      "example.ts",
      new ThrowingApplyLLM() as unknown as ILLM,
      new AbortController(),
    );

    const diffLines = await collectDiffLines(diffLinesGenerator);

    expect(isInstantApply).toBe(true);
    expect(diffLines).toEqual([
      { type: "same", line: "function value() {" },
      { type: "old", line: "  return 1;" },
      { type: "new", line: "  return 2;" },
      { type: "same", line: "}" },
    ]);
  });
});
