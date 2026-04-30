/**
 * QueueManager — Shared context layer for autocomplete and NextEdit.
 *
 * Owns all snippet queues, warming state machine, and readiness tracking.
 * Located in core/ — no IDE-specific dependencies. VS Code / PyCharm
 * adapter layers call pushEdited(), pushVisited(), etc. via IDE events.
 *
 * Design (README §二, §三, §七):
 * - Three-layer architecture: shared context layer (this) → autocomplete consumer → NextEdit consumer
 * - Two-level readiness: core-ready (edited/visited/opened available) → full-ready (import/rootPath done)
 * - Pure in-memory, no persistence
 */

import {
  AutocompleteCodeSnippet,
  AutocompleteDiffSnippet,
  AutocompleteSnippetType,
} from "../snippets/types";

import { estimateTokenCount, QueueEntry, SnippetQueue } from "./SnippetQueue";

/**
 * Budget ratios for each queue (README §四).
 * Must sum to ≤ 1.0. Remainder (rootPathReserve) is used for dynamic derivation.
 */
export const QUEUE_BUDGET_RATIOS = {
  editedRanges: 0.25,
  visitedRanges: 0.25,
  openedFiles: 0.1,
  importDefs: 0.15,
  diff: 0.1,
  // rootPathReserve: 0.15 — not a queue, used for dynamic derivation in debounce-after
} as const;

/** Over-provisioning factor for queue capacity (README §四). */
const OVER_PROVISION = 1.2;

/**
 * Default snippet budget when maxPromptTokens is unknown.
 * Derived from: maxPromptTokens(4096) - prefix(~1200) - suffix(~800) ≈ 2000
 */
const DEFAULT_SNIPPET_BUDGET = 2000;

export type ReadinessLevel = "none" | "core-ready" | "full-ready";

export interface WarmingState {
  filepath: string;
  readiness: ReadinessLevel;
  abortController: AbortController | null;
}

export interface TakeAllResult {
  editedSnippets: QueueEntry[];
  visitedSnippets: QueueEntry[];
  openedSnippets: QueueEntry[];
  importSnippets: QueueEntry[];
  diffSnippets: QueueEntry[];
  /** Remaining budget after all queues, available for rootPath dynamic derivation. */
  rootPathBudget: number;
}

export class QueueManager {
  // --- Queues ---
  readonly editedRangesQueue: SnippetQueue;
  readonly visitedRangesQueue: SnippetQueue;
  readonly openedFilesQueue: SnippetQueue;
  readonly importQueue: SnippetQueue;
  readonly diffQueue: SnippetQueue;

  // --- Warming state (per-file) ---
  private warmingStates: Map<string, WarmingState> = new Map();

  /** Maximum number of files with editedRanges entries to retain (README §十三.2). */
  private readonly maxEditedFiles = 5;

  constructor(snippetBudget: number = DEFAULT_SNIPPET_BUDGET) {
    const cap = (ratio: number) =>
      Math.ceil(snippetBudget * ratio * OVER_PROVISION);

    this.editedRangesQueue = new SnippetQueue(
      cap(QUEUE_BUDGET_RATIOS.editedRanges),
    );
    this.visitedRangesQueue = new SnippetQueue(
      cap(QUEUE_BUDGET_RATIOS.visitedRanges),
    );
    this.openedFilesQueue = new SnippetQueue(
      cap(QUEUE_BUDGET_RATIOS.openedFiles),
    );
    this.importQueue = new SnippetQueue(cap(QUEUE_BUDGET_RATIOS.importDefs));
    this.diffQueue = new SnippetQueue(cap(QUEUE_BUDGET_RATIOS.diff));
  }

  // ─── Push interfaces (called by IDE adapter layer) ───

  /**
   * Push an edited range snippet. Called on text document changes.
   */
  pushEdited(
    filepath: string,
    content: string,
    startLine: number,
    endLine: number,
  ): void {
    // [zkdev] Strip IntelliJ dummy identifier that may leak through from document events
    if (content.includes("IntellijIdeaRulezzz")) {
      content = content.replace(/IntellijIdeaRulezzz\s*/g, "");
    }
    this.editedRangesQueue.push({
      filepath,
      content,
      startLine,
      endLine,
      tokenCount: estimateTokenCount(content),
      timestamp: Date.now(),
      snippetType: "code",
    });
  }

  /**
   * Push a visited range snippet. Called on cursor/selection changes.
   */
  pushVisited(
    filepath: string,
    content: string,
    startLine: number,
    endLine: number,
  ): void {
    this.visitedRangesQueue.push({
      filepath,
      content,
      startLine,
      endLine,
      tokenCount: estimateTokenCount(content),
      timestamp: Date.now(),
      snippetType: "code",
    });
  }

  /**
   * Push an opened file snippet (windowed, not full-text).
   * Caller is responsible for extracting the high-value window
   * (file header + cursor vicinity) before calling.
   */
  pushOpenedFile(
    filepath: string,
    content: string,
    startLine: number,
    endLine: number,
  ): void {
    this.openedFilesQueue.push({
      filepath,
      content,
      startLine,
      endLine,
      tokenCount: estimateTokenCount(content),
      timestamp: Date.now(),
      snippetType: "code",
    });
  }

  /**
   * Push an import definition snippet. Called during warming.
   */
  pushImportDef(
    filepath: string,
    content: string,
    startLine: number,
    endLine: number,
  ): void {
    this.importQueue.push({
      filepath,
      content,
      startLine,
      endLine,
      tokenCount: estimateTokenCount(content),
      timestamp: Date.now(),
      snippetType: "definition",
    });
  }

  /**
   * Push a diff snippet.
   */
  pushDiff(content: string): void {
    this.diffQueue.push({
      filepath: "",
      content,
      startLine: 0,
      endLine: 0,
      tokenCount: estimateTokenCount(content),
      timestamp: Date.now(),
      snippetType: "diff",
    });
  }

  /**
   * Remove opened file entry when tab is closed.
   */
  removeOpenedFile(filepath: string): void {
    this.openedFilesQueue.removeByFilepath(filepath);
  }

  // ─── Warming state machine (README §七) ───

  /**
   * Mark a file as core-ready (edited/visited/opened queues populated).
   * Called synchronously when user opens/switches to a file.
   */
  markCoreReady(filepath: string): void {
    const existing = this.warmingStates.get(filepath);
    if (existing && existing.readiness === "full-ready") {
      return; // Already full-ready, don't downgrade
    }
    console.log(`[Queue Warming] ${filepath} → core-ready`);
    this.warmingStates.set(filepath, {
      filepath,
      readiness: "core-ready",
      abortController: existing?.abortController ?? null,
    });
  }

  /**
   * Mark a file as full-ready (import/rootPath warming complete).
   */
  markFullReady(filepath: string): void {
    const existing = this.warmingStates.get(filepath);
    console.log(`[Queue Warming] ${filepath} → full-ready`);
    this.warmingStates.set(filepath, {
      filepath,
      readiness: "full-ready",
      abortController: null, // Warming done, no need for abort
    });
  }

  /**
   * Start warming for a file. Returns an AbortController the caller can use
   * to cancel warming (e.g. on rapid tab switch).
   * Cancels any existing warming for other files (max 1 concurrent).
   */
  startWarming(filepath: string): AbortController {
    // Cancel any existing warming for other files
    for (const [fp, state] of this.warmingStates) {
      if (fp !== filepath && state.abortController) {
        state.abortController.abort();
        state.abortController = null;
      }
    }

    // Create new abort controller for this file
    const controller = new AbortController();
    const existing = this.warmingStates.get(filepath);
    this.warmingStates.set(filepath, {
      filepath,
      readiness: existing?.readiness ?? "none",
      abortController: controller,
    });

    return controller;
  }

  /**
   * Get the readiness level for a file.
   */
  getReadiness(filepath: string): ReadinessLevel {
    return this.warmingStates.get(filepath)?.readiness ?? "none";
  }

  /**
   * Check if a file is at least core-ready (safe to produce autocomplete).
   */
  isReady(filepath: string): boolean {
    const r = this.getReadiness(filepath);
    return r === "core-ready" || r === "full-ready";
  }

  // ─── Consumer interface (README §六) ───

  /**
   * Take snippets from all queues, respecting budget ratios.
   * Called by autocomplete consumer after debounce.
   *
   * @param totalSnippetBudget Actual snippet budget after prefix/suffix deduction.
   */
  takeAll(totalSnippetBudget: number): TakeAllResult {
    const editedBudget = Math.floor(
      totalSnippetBudget * QUEUE_BUDGET_RATIOS.editedRanges,
    );
    const visitedBudget = Math.floor(
      totalSnippetBudget * QUEUE_BUDGET_RATIOS.visitedRanges,
    );
    const openedBudget = Math.floor(
      totalSnippetBudget * QUEUE_BUDGET_RATIOS.openedFiles,
    );
    const importBudget = Math.floor(
      totalSnippetBudget * QUEUE_BUDGET_RATIOS.importDefs,
    );
    const diffBudget = Math.floor(
      totalSnippetBudget * QUEUE_BUDGET_RATIOS.diff,
    );

    const editedSnippets = this.editedRangesQueue.takeUpTo(editedBudget);
    const visitedSnippets = this.visitedRangesQueue.takeUpTo(visitedBudget);
    const openedSnippets = this.openedFilesQueue.takeUpTo(openedBudget);
    const importSnippets = this.importQueue.takeUpTo(importBudget);
    const diffSnippets = this.diffQueue.takeUpTo(diffBudget);

    // Calculate leftover from each queue
    const editedUsed = editedSnippets.reduce((s, e) => s + e.tokenCount, 0);
    const visitedUsed = visitedSnippets.reduce((s, e) => s + e.tokenCount, 0);
    const openedUsed = openedSnippets.reduce((s, e) => s + e.tokenCount, 0);
    const importUsed = importSnippets.reduce((s, e) => s + e.tokenCount, 0);
    const diffUsed = diffSnippets.reduce((s, e) => s + e.tokenCount, 0);

    const leftover =
      editedBudget -
      editedUsed +
      (visitedBudget - visitedUsed) +
      (openedBudget - openedUsed) +
      (importBudget - importUsed) +
      (diffBudget - diffUsed);

    // rootPath reserve + leftovers
    const rootPathReserve = Math.floor(totalSnippetBudget * 0.15);
    const rootPathBudget = rootPathReserve + leftover;

    // Diagnostic logging
    console.log(
      `[Queue TakeAll] budget=${totalSnippetBudget} ` +
        `edited=${editedSnippets.length}(${editedUsed}t) ` +
        `visited=${visitedSnippets.length}(${visitedUsed}t) ` +
        `opened=${openedSnippets.length}(${openedUsed}t) ` +
        `import=${importSnippets.length}(${importUsed}t) ` +
        `diff=${diffSnippets.length}(${diffUsed}t) ` +
        `rootPathBudget=${rootPathBudget}`,
    );

    return {
      editedSnippets,
      visitedSnippets,
      openedSnippets,
      importSnippets,
      diffSnippets,
      rootPathBudget,
    };
  }

  /**
   * Get a shared context snapshot for NextEdit or other consumers.
   * Returns all queue contents without budget constraints.
   */
  getSharedContext(): {
    edited: QueueEntry[];
    visited: QueueEntry[];
    opened: QueueEntry[];
    imports: QueueEntry[];
    diffs: QueueEntry[];
  } {
    return {
      edited: [...this.editedRangesQueue.snapshot()],
      visited: [...this.visitedRangesQueue.snapshot()],
      opened: [...this.openedFilesQueue.snapshot()],
      imports: [...this.importQueue.snapshot()],
      diffs: [...this.diffQueue.snapshot()],
    };
  }

  /**
   * Convert takeAll result to SnippetPayload for compatibility with
   * existing renderPromptWithTokenLimit pipeline.
   */
  toSnippetPayload(totalSnippetBudget: number): {
    recentlyEditedRangeSnippets: AutocompleteCodeSnippet[];
    recentlyVisitedRangesSnippets: AutocompleteCodeSnippet[];
    recentlyOpenedFileSnippets: AutocompleteCodeSnippet[];
    importDefinitionSnippets: AutocompleteCodeSnippet[];
    diffSnippets: AutocompleteDiffSnippet[];
    rootPathBudget: number;
  } {
    const result = this.takeAll(totalSnippetBudget);

    const toCodeSnippet = (e: QueueEntry): AutocompleteCodeSnippet => ({
      filepath: e.filepath,
      content: e.content,
      type: AutocompleteSnippetType.Code,
      startLine: e.startLine,
      endLine: e.endLine,
    });

    const toDiffSnippet = (e: QueueEntry): AutocompleteDiffSnippet => ({
      content: e.content,
      type: AutocompleteSnippetType.Diff,
    });

    return {
      recentlyEditedRangeSnippets: result.editedSnippets.map(toCodeSnippet),
      recentlyVisitedRangesSnippets: result.visitedSnippets.map(toCodeSnippet),
      recentlyOpenedFileSnippets: result.openedSnippets.map(toCodeSnippet),
      importDefinitionSnippets: result.importSnippets.map(toCodeSnippet),
      diffSnippets: result.diffSnippets.map(toDiffSnippet),
      rootPathBudget: result.rootPathBudget,
    };
  }

  /**
   * Clear all queues and warming states. Called on IDE restart (if needed).
   */
  reset(): void {
    this.editedRangesQueue.clear();
    this.visitedRangesQueue.clear();
    this.openedFilesQueue.clear();
    this.importQueue.clear();
    this.diffQueue.clear();

    // Abort any in-progress warming
    for (const state of this.warmingStates.values()) {
      state.abortController?.abort();
    }
    this.warmingStates.clear();
  }
}
