import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("compactConversation imports", () => {
  it("does not import the Redux store singleton during webview startup", () => {
    const source = readFileSync(
      join(__dirname, "compactConversation.ts"),
      "utf8",
    );

    expect(source).not.toContain('from "../redux/store"');
  });
});
