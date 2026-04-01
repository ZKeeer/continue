/**
 * [zkdev] P2: Generic FIM-based NextEdit Provider
 *
 * Enables NextEdit functionality for any FIM-capable model (e.g., qwen3-coder).
 * Uses the model's chat API with a structured prompt that includes:
 * - An editable region around the cursor
 * - Recent edit history as diff context
 * - Code snippets for cross-file context
 *
 * Key design decisions:
 * - System instructions are embedded in the user prompt (only prompts[1] is sent)
 * - Larger editable region window (10 lines top, 15 bottom) for better context
 * - historyDiff (unified diff of recent file changes) is preferred over raw diffContext
 * - Handles <think> tags for models that use thinking (e.g., qwen3-coder)
 */

import { HelperVars } from "../../autocomplete/util/HelperVars.js";
import { ModelSpecificContext, Prompt, PromptMetadata } from "../types.js";
import { BaseNextEditModelProvider } from "./BaseNextEditProvider.js";

const GENERIC_SYSTEM_INSTRUCTIONS = [
  "You are a code edit predictor. Given the current file with an editable region marked by <|editable_region_start|> and <|editable_region_end|>, predict what the developer intends to change next.",
  "Rules:",
  "1. Output ONLY the new content for the editable region, no markers.",
  "2. If no change is needed, output the editable region unchanged.",
  "3. Make minimal, focused changes.",
  "4. Do NOT wrap output in markdown code fences.",
].join("\n");

export class GenericFimNextEditProvider extends BaseNextEditModelProvider {
  constructor() {
    super("generic-fim");
  }

  getSystemPrompt(): string {
    return GENERIC_SYSTEM_INSTRUCTIONS;
  }

  getWindowSize() {
    // [zkdev] Increased from {1, 5} for better context around cursor
    return { topMargin: 10, bottomMargin: 15 };
  }

  shouldInjectUniqueToken(): boolean {
    return false;
  }

  getUniqueToken(): string | null {
    return null;
  }

  extractCompletion(message: string): string {
    let result = message.trim();

    // [zkdev] Handle <think>...</think> tags from qwen3-coder
    result = result.replace(/<think>.*?<\/think>/s, "");
    result = result.replace(/<\/think>/, "");

    // Strip markdown code fences
    if (result.startsWith("```")) {
      const firstNewline = result.indexOf("\n");
      if (firstNewline !== -1) {
        result = result.slice(firstNewline + 1);
      }
      if (result.endsWith("```")) {
        result = result.slice(0, result.lastIndexOf("```"));
      }
    }

    return result.trim();
  }

  buildPromptContext(context: ModelSpecificContext): {
    currentFileContent: string;
    editHistory: string;
    contextSnippets: string;
    filepath: string;
    language: string;
  } {
    const { helper, editableRegionStartLine, editableRegionEndLine } = context;
    const lines = helper.fileLines;

    // Build file content with editable region markers
    const windowStart = Math.max(0, editableRegionStartLine - 50);
    const windowEnd = Math.min(
      lines.length - 1,
      editableRegionEndLine + 50,
    );

    const contentLines: string[] = [];
    for (let i = windowStart; i <= windowEnd; i++) {
      if (i === editableRegionStartLine) {
        contentLines.push("<|editable_region_start|>");
      }
      contentLines.push(lines[i]);
      if (i === editableRegionEndLine) {
        contentLines.push("<|editable_region_end|>");
      }
    }

    // [zkdev] Prefer historyDiff (unified diff) over raw diffContext strings
    let editHistory: string;
    if (context.historyDiff && context.historyDiff.trim().length > 0) {
      editHistory = context.historyDiff;
    } else if (context.diffContext.length > 0) {
      editHistory = context.diffContext.slice(-3).join("\n---\n");
    } else {
      editHistory = "No recent edits.";
    }

    // Format context snippets from autocomplete context
    const contextSnippets = context.autocompleteContext || "";

    return {
      currentFileContent: contentLines.join("\n"),
      editHistory,
      contextSnippets,
      filepath: helper.filepath,
      language: helper.lang.name,
    };
  }

  async generatePrompts(context: ModelSpecificContext): Promise<Prompt[]> {
    const promptCtx = this.buildPromptContext(context);

    // [zkdev] Embed system instructions in user prompt since only prompts[1] is sent
    const parts: string[] = [
      GENERIC_SYSTEM_INSTRUCTIONS,
      "",
      `File: ${promptCtx.filepath} (${promptCtx.language})`,
    ];

    if (promptCtx.editHistory !== "No recent edits.") {
      parts.push("", "Recent changes:", promptCtx.editHistory);
    }

    if (promptCtx.contextSnippets) {
      parts.push("", "Related code:", promptCtx.contextSnippets);
    }

    parts.push(
      "",
      "Current code:",
      promptCtx.currentFileContent,
      "",
      "Output the new editable region content:",
    );

    const userContent = parts.join("\n");

    return [
      {
        role: "system",
        content: this.getSystemPrompt(),
      },
      {
        role: "user",
        content: userContent,
      },
    ];
  }

  buildPromptMetadata(context: ModelSpecificContext): PromptMetadata {
    const promptCtx = this.buildPromptContext(context);

    return {
      prompt: {
        role: "user",
        content: [
          `File: ${promptCtx.filepath}`,
          "",
          "Recent changes:",
          promptCtx.editHistory,
          "",
          "Current code:",
          promptCtx.currentFileContent,
        ].join("\n"),
      },
      userEdits: promptCtx.editHistory,
      userExcerpts: promptCtx.currentFileContent,
    };
  }

  calculateEditableRegion(
    helper: HelperVars,
    usingFullFileDiff: boolean,
  ): {
    editableRegionStartLine: number;
    editableRegionEndLine: number;
  } {
    if (usingFullFileDiff) {
      return this.calculateOptimalEditableRegion(helper, 512, "tokenizer");
    } else {
      const { topMargin, bottomMargin } = this.getWindowSize();
      return {
        editableRegionStartLine: Math.max(helper.pos.line - topMargin, 0),
        editableRegionEndLine: Math.min(
          helper.pos.line + bottomMargin,
          helper.fileLines.length - 1,
        ),
      };
    }
  }
}
