import { IDE } from "core";
import { QueueManager } from "core/autocomplete/context/QueueManager";
import {
  AutocompleteCodeSnippet,
  AutocompleteSnippetType,
} from "core/autocomplete/snippets/types";
import { isSecurityConcern } from "core/indexing/ignore";
import { PosthogFeatureFlag, Telemetry } from "core/util/posthog";
import { LRUCache } from "lru-cache";
import * as vscode from "vscode";

/**
 * Service to keep track of recently visited ranges in files.
 */
export class RecentlyVisitedRangesService {
  private cache: LRUCache<
    string,
    Array<AutocompleteCodeSnippet & { timestamp: number }>
  >;
  // Default value, we override in initWithPostHog
  // [zkdev] Increased from 20→30 to capture broader cursor context with 4096 token budget
  private numSurroundingLines = 30;
  // [zkdev] Expanded from 3→5 to cover more of the working set;
  // with priority reorder (visitedRanges=2 > openedFiles=3), cursor-aware
  // snippets from these files take precedence over full-file fallback
  private maxRecentFiles = 5;
  private maxSnippetsPerFile = 3;
  private isEnabled = true;

  constructor(
    private readonly ide: IDE,
    private readonly queueManager?: QueueManager,
  ) {
    this.cache = new LRUCache<
      string,
      Array<AutocompleteCodeSnippet & { timestamp: number }>
    >({
      max: this.maxRecentFiles,
    });

    void this.initWithPostHog();
  }

  private async initWithPostHog() {
    const recentlyVisitedRangesNumSurroundingLines =
      await Telemetry.getValueForFeatureFlag(
        PosthogFeatureFlag.RecentlyVisitedRangesNumSurroundingLines,
      );

    if (recentlyVisitedRangesNumSurroundingLines) {
      this.isEnabled = true;
      this.numSurroundingLines = recentlyVisitedRangesNumSurroundingLines;
    }

    vscode.window.onDidChangeTextEditorSelection(
      this.cacheCurrentSelectionContext,
    );
  }

  private cacheCurrentSelectionContext = async (
    event: vscode.TextEditorSelectionChangeEvent,
  ) => {
    const fsPath = event.textEditor.document.fileName;
    if (isSecurityConcern(fsPath)) {
      return;
    }
    const filepath = event.textEditor.document.uri.toString();
    const line = event.selections[0].active.line;
    const startLine = Math.max(0, line - this.numSurroundingLines);
    const endLine = Math.min(
      line + this.numSurroundingLines,
      event.textEditor.document.lineCount - 1,
    );

    try {
      // [zkdev] P0 fix: Read directly from editor document model (in-memory)
      // instead of ide.readFile() which does full-file disk IO on every selection change.
      // document.getText(range) is zero-IO: reads from VS Code's in-memory TextDocument.
      // Compatible with VS Code 1.70.0+ (TextDocument.getText exists since API v1.0).
      const range = new vscode.Range(
        startLine,
        0,
        endLine,
        event.textEditor.document.lineAt(endLine).text.length,
      );
      const relevantLines = event.textEditor.document.getText(range).trim();

      const snippet: AutocompleteCodeSnippet & { timestamp: number } = {
        filepath,
        content: relevantLines,
        type: AutocompleteSnippetType.Code,
        // [zkdev] Propagate line range for overlap-aware dedup in filtering.ts
        startLine,
        endLine,
        timestamp: Date.now(),
      };

      const existing = this.cache.get(filepath) || [];
      const newSnippets = [...existing, snippet]
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, this.maxSnippetsPerFile);

      this.cache.set(filepath, newSnippets);

      // Push to shared context queue (Phase 2)
      if (this.queueManager) {
        this.queueManager.pushVisited(filepath, relevantLines, startLine, endLine);
      }
    } catch (err) {
      console.error(
        "Error caching recently visited ranges for autocomplete: ",
        err,
      );
      return;
    }
  };

  /**
   * Returns up to {@link maxSnippetsPerFile} snippets from the {@link maxRecentFiles} most recently visited files.
   * Excludes snippets from the currently active file.
   * @returns Array of code snippets from recently visited files
   */
  public getSnippets(): AutocompleteCodeSnippet[] {
    if (!this.isEnabled) {
      return [];
    }

    const currentFilepath =
      vscode.window.activeTextEditor?.document.uri.toString();
    let allSnippets: Array<AutocompleteCodeSnippet & { timestamp: number }> =
      [];

    // Get most recent snippets from each file in cache
    for (const filepath of Array.from(this.cache.keys())) {
      const snippets = (this.cache.get(filepath) || [])
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, this.maxSnippetsPerFile);
      allSnippets = [...allSnippets, ...snippets];
    }

    return allSnippets
      .filter(
        (s) =>
          !currentFilepath ||
          (s.filepath !== currentFilepath &&
            // [zkdev] Exclude ALL output panels (output:exthost, output:extension-output-*, etc.)
            // These contain VS Code internal logs, not code — they pollute prompt context.
            // Previously only filtered Continue's own output; now filters any output: URI.
            !s.filepath.startsWith("output:")),
      )
      .sort((a, b) => b.timestamp - a.timestamp)
      .map(({ timestamp, ...snippet }) => snippet);
  }
}
