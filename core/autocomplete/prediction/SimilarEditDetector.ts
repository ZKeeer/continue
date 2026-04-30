/**
 * [zkdev] P3: Similar Edit Detector
 *
 * Detects when the user is making repetitive similar edits across multiple
 * locations (e.g., adding the same parameter to multiple functions, applying
 * the same refactoring pattern).
 *
 * When a pattern is detected, finds other code locations that likely need
 * the same edit, and pre-populates the autocomplete cache with predicted
 * completions for those locations.
 *
 * Integration: Called from CompletionProvider.accept() after recording the
 * accepted completion. Uses tree-sitter AST paths and simple text matching
 * to find similar code structures.
 *
 * This is a lightweight heuristic detector — not a full AST transformer.
 */

import { AutocompleteOutcome } from "../util/types.js";

interface EditRecord {
  /** The prefix text before the cursor for this edit */
  prefix: string;
  /** The completion that was accepted */
  completion: string;
  /** File where the edit was made */
  filepath: string;
  /** Timestamp */
  timestamp: number;
  /** The line content before the edit (for pattern matching) */
  contextLine: string;
}

interface SimilarLocation {
  /** The predicted new prefix (cache key) */
  predictedPrefix: string;
  /** The predicted completion */
  predictedCompletion: string;
}

export class SimilarEditDetector {
  private editHistory: EditRecord[] = [];
  private readonly maxHistory = 20;
  private readonly patternThreshold = 2; // Need at least 2 similar edits to detect a pattern

  /**
   * Record an accepted completion for pattern detection.
   */
  recordEdit(outcome: AutocompleteOutcome): void {
    // Extract the context: the last line of the prefix (which is the line being edited)
    const prefixLines = outcome.prefix.split("\n");
    const contextLine = prefixLines[prefixLines.length - 1] || "";

    this.editHistory.push({
      prefix: outcome.prefix,
      completion: outcome.completion,
      filepath: outcome.filepath,
      timestamp: Date.now(),
      contextLine: contextLine.trim(),
    });

    // Keep history bounded
    if (this.editHistory.length > this.maxHistory) {
      this.editHistory.shift();
    }
  }

  /**
   * Detect if the most recent edits form a repeating pattern.
   * Returns locations where the same edit pattern should be applied.
   *
   * @param fileContent The current file content to search for similar locations
   * @param filepath The current file path
   */
  detectSimilarLocations(
    fileContent: string,
    filepath: string,
  ): SimilarLocation[] {
    // Only consider edits from the last 5 minutes
    const recentEdits = this.editHistory.filter(
      (e) => Date.now() - e.timestamp < 300_000,
    );

    if (recentEdits.length < this.patternThreshold) {
      return [];
    }

    // Group recent edits by pattern similarity
    const pattern = this.extractPattern(recentEdits);
    if (!pattern) return [];

    // Find other locations in the file that match the pattern
    return this.findMatchingLocations(pattern, fileContent, filepath);
  }

  /**
   * Extract a repeating edit pattern from recent edits.
   *
   * A pattern is defined as: similar context_line structure + similar completion.
   * "Similar" means the edits share structural tokens (brackets, keywords, etc.)
   * while differing in identifiers.
   */
  private extractPattern(
    edits: EditRecord[],
  ): EditPattern | undefined {
    // Check the last few edits (most recent first)
    const recent = edits.slice(-5).reverse();

    // Try to find edits with similar completions
    for (let i = 0; i < recent.length; i++) {
      const matchingEdits = [recent[i]];

      for (let j = i + 1; j < recent.length; j++) {
        if (this.areEditsSimilar(recent[i], recent[j])) {
          matchingEdits.push(recent[j]);
        }
      }

      if (matchingEdits.length >= this.patternThreshold) {
        // Extract the common structural pattern
        return {
          contextStructure: this.extractStructure(matchingEdits[0].contextLine),
          completionStructure: this.extractStructure(matchingEdits[0].completion),
          examples: matchingEdits,
        };
      }
    }

    return undefined;
  }

  /**
   * Check if two edits are structurally similar.
   * They're similar if the completions share the same "skeleton" (keywords + punctuation)
   * but differ in identifiers.
   */
  private areEditsSimilar(a: EditRecord, b: EditRecord): boolean {
    const structA = this.extractStructure(a.completion);
    const structB = this.extractStructure(b.completion);

    // Structural skeleton must match
    if (structA !== structB) return false;

    // Note: identical completions are now allowed — this is the most common
    // batch edit scenario (e.g., adding same parameter to multiple functions).
    // The cache system handles dedup via key matching.

    // Context lines should also be structurally similar
    const ctxStructA = this.extractStructure(a.contextLine);
    const ctxStructB = this.extractStructure(b.contextLine);

    return ctxStructA === ctxStructB;
  }

  /**
   * Extract the structural "skeleton" of a code string.
   * Replaces identifiers with placeholders while keeping keywords and punctuation.
   */
  private extractStructure(code: string): string {
    return code
      .trim()
      // Replace string literals with placeholder
      .replace(/(["'`])(?:(?!\1).)*\1/g, "STR")
      // Replace numbers
      .replace(/\b\d+\b/g, "NUM")
      // Replace identifiers (words that aren't keywords) with placeholder
      .replace(
        /\b(?!(?:function|const|let|var|if|else|return|import|export|class|interface|type|async|await|for|while|switch|case|break|continue|new|this|true|false|null|undefined|void|typeof|instanceof|in|of|try|catch|finally|throw|extends|implements|abstract|private|public|protected|static|readonly)\b)[a-zA-Z_$][a-zA-Z0-9_$]*\b/g,
        "ID",
      )
      // Normalize whitespace
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Find locations in the file content that match the edit pattern's context structure.
   */
  private findMatchingLocations(
    pattern: EditPattern,
    fileContent: string,
    filepath: string,
  ): SimilarLocation[] {
    const lines = fileContent.split("\n");
    const locations: SimilarLocation[] = [];
    const alreadyEdited = new Set(
      pattern.examples.map((e) => e.contextLine),
    );

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Skip empty lines and lines that were already edited
      if (!line || alreadyEdited.has(line)) continue;

      // Check if this line's structure matches the pattern's context
      const lineStructure = this.extractStructure(line);
      if (lineStructure !== pattern.contextStructure) continue;

      // Found a matching location — predict the completion by applying the pattern
      const predictedCompletion = this.applyPattern(
        pattern,
        line,
      );
      if (!predictedCompletion) continue;

      // Build the predicted prefix (lines up to and including this line)
      const predictedPrefix = lines.slice(0, i + 1).join("\n");

      locations.push({
        predictedPrefix,
        predictedCompletion,
      });

      // Limit to 5 predictions per detection to avoid runaway
      if (locations.length >= 5) break;
    }

    return locations;
  }

  /**
   * Apply the detected edit pattern to a new location.
   * Uses the first example's completion as a template, substituting identifiers
   * from the new context line.
   */
  private applyPattern(
    pattern: EditPattern,
    newContextLine: string,
  ): string | undefined {
    if (pattern.examples.length === 0) return undefined;

    const example = pattern.examples[0];

    // Extract identifiers from old context line and new context line
    const oldIds = this.extractIdentifiers(example.contextLine);
    const newIds = this.extractIdentifiers(newContextLine);

    if (oldIds.length === 0 || newIds.length === 0) return undefined;
    if (oldIds.length !== newIds.length) return undefined;

    // Build a replacement map: old identifier → new identifier
    let result = example.completion;
    for (let i = 0; i < oldIds.length; i++) {
      if (oldIds[i] !== newIds[i]) {
        // Replace all occurrences of the old identifier with the new one
        // Use word boundary matching to avoid partial replacements
        const regex = new RegExp(`\\b${escapeRegExp(oldIds[i])}\\b`, "g");
        result = result.replace(regex, newIds[i]);
      }
    }

    return result;
  }

  /**
   * Extract identifiers from a code string (non-keyword words).
   */
  private extractIdentifiers(code: string): string[] {
    const keywords = new Set([
      "function", "const", "let", "var", "if", "else", "return",
      "import", "export", "class", "interface", "type", "async",
      "await", "for", "while", "switch", "case", "break", "continue",
      "new", "this", "true", "false", "null", "undefined", "void",
      "typeof", "instanceof", "in", "of", "try", "catch", "finally",
      "throw", "extends", "implements", "abstract", "private", "public",
      "protected", "static", "readonly",
    ]);

    const matches = code.match(/\b[a-zA-Z_$][a-zA-Z0-9_$]*\b/g) || [];
    return matches.filter((m) => !keywords.has(m));
  }

  /**
   * Get the edit history (for external consumers like the prefetch service).
   */
  getRecentEdits(): EditRecord[] {
    return [...this.editHistory];
  }

  /**
   * Clear old entries.
   */
  pruneOld(maxAgeMs: number = 300_000): void {
    const cutoff = Date.now() - maxAgeMs;
    this.editHistory = this.editHistory.filter((e) => e.timestamp >= cutoff);
  }
}

interface EditPattern {
  contextStructure: string;
  completionStructure: string;
  examples: EditRecord[];
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
