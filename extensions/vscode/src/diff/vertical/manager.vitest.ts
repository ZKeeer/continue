import { beforeEach, describe, expect, it, vi } from "vitest";

const vscodeMock = vi.hoisted(() => {
  class Position {
    constructor(
      public line: number,
      public character: number,
    ) {}

    translate(lineDelta = 0, characterDelta = 0) {
      return new Position(this.line + lineDelta, this.character + characterDelta);
    }
  }

  class Range {
    constructor(
      public start: Position | number,
      public end: Position | number,
      public endLine?: number,
      public endCharacter?: number,
    ) {
      if (typeof start === "number") {
        this.start = new Position(start, end as number);
        this.end = new Position(endLine ?? start, endCharacter ?? (end as number));
      }
    }
  }

  return {
    commands: {
      executeCommand: vi.fn(),
    },
    window: {
      activeTextEditor: undefined as any,
      onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
    },
    workspace: {
      onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
      openTextDocument: vi.fn(),
    },
    Position,
    Range,
    Selection: class Selection {},
    TextEditorRevealType: {
      Default: 0,
    },
  };
});

vi.mock("vscode", () => vscodeMock);

const verticalDiffHandlerMock = vi.hoisted(() => vi.fn());

vi.mock("./handler", () => ({
  VerticalDiffHandler: verticalDiffHandlerMock,
}));

import * as vscode from "vscode";

import { VerticalDiffManager } from "./manager";

function createEditor(fileUri: string, text: string) {
  const lines = text.split("\n");

  return {
    document: {
      uri: {
        toString: () => fileUri,
      },
      getText: vi.fn(() => text),
      lineCount: lines.length,
      lineAt: vi.fn((line: number) => ({ text: lines[line] ?? "" })),
    },
    revealRange: vi.fn(),
    selection: undefined,
    setDecorations: vi.fn(),
    edit: vi.fn(),
  } as any;
}

describe("VerticalDiffManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verticalDiffHandlerMock.mockImplementation((...args: any[]) => {
      const options = args[6];

      return {
        baseFileContent: options.baseFileContent,
        clear: vi.fn(),
        reapplyWithMyersDiff: vi.fn().mockResolvedValue([]),
        streamId: options.streamId,
      };
    });
  });

  it("accumulates a second same-file instant apply without rejecting the previous pending diff", async () => {
    const fileUri = "file:///workspace/example.ts";
    (vscode.window as any).activeTextEditor = createEditor(
      fileUri,
      "const value = 1;\n",
    );

    const webviewProtocol = {
      request: vi.fn().mockResolvedValue(undefined),
    } as any;
    const manager = new VerticalDiffManager(webviewProtocol, {} as any, {} as any);
    const existingHandler = {
      baseFileContent: "const value = 0;\n",
      clear: vi.fn(),
      reapplyWithMyersDiff: vi.fn().mockResolvedValue([]),
    };

    (manager as any).fileUriToHandler.set(fileUri, existingHandler);

    await manager.instantApplyDiff(
      "const value = 1;\n",
      "const value = 2;\n",
      "stream-2",
      "tool-2",
    );

    expect(existingHandler.clear).not.toHaveBeenCalled();
    expect(existingHandler.reapplyWithMyersDiff).toHaveBeenCalled();
    expect(webviewProtocol.request).toHaveBeenCalledWith(
      "updateApplyState",
      expect.objectContaining({
        streamId: "stream-2",
        status: "done",
        filepath: fileUri,
        toolCallId: "tool-2",
        originalFileContent: "const value = 0;\n",
      }),
    );
  });
});