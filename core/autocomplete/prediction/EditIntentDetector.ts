/**
 * [zkdev] P1: Edit Intent Detector
 *
 * Analyzes recently edited ranges to detect repetitive editing patterns.
 * When a pattern is found, generates a concise intent description that
 * can be injected into the autocomplete prompt to guide the model.
 *
 * This is a lightweight heuristic approach — the model is much better at
 * inferring intent from context, so we just enhance the signal.
 */

import { AutocompleteSnippetType, AutocompleteStaticSnippet } from "../snippets/types.js";

interface RecentEdit {
  filepath: string;
  lines: string[];
  timestamp: number;
  symbols: Set<string>;
}

// Pattern definitions: keywords that suggest a specific editing intent
const INTENT_PATTERNS = [
  { keywords: ["try", "catch"], intent: "adding error handling (try/catch)" },
  { keywords: ["async", "await"], intent: "converting to async/await" },
  {
    keywords: ["interface", "type "],
    intent: "adding TypeScript type definitions",
  },
  { keywords: ["export"], intent: "exporting symbols" },
  { keywords: ["private", "protected", "public"], intent: "adjusting access modifiers" },
  { keywords: ["?."], intent: "adding optional chaining for null safety" },
  { keywords: ["console.log", "console.error", "logger."], intent: "adding logging" },
  { keywords: ["describe(", "it(", "test(", "expect("], intent: "writing tests" },
  {
    keywords: ["import ", "require("],
    intent: "adding imports",
  },
  { keywords: ["@param", "@returns", "/**"], intent: "adding documentation" },
  { keywords: ["if (", "else {", "switch ("], intent: "adding conditional logic" },
  { keywords: ["TODO", "FIXME", "HACK", "XXX"], intent: "adding TODO annotations" },
] as const;

/**
 * Analyze recent edits and return an intent description if a pattern is detected.
 * Returns undefined if no clear pattern is found (avoids injecting noise).
 */
export function detectEditIntent(recentEdits: RecentEdit[]): string | undefined {
  // Need at least 2 recent edits to detect a pattern
  if (recentEdits.length < 2) return undefined;

  // Only consider edits from the last 120 seconds
  const now = Date.now();
  const recent = recentEdits.filter((e) => now - e.timestamp < 120_000);
  if (recent.length < 2) return undefined;

  const allLines = recent.flatMap((e) => e.lines);
  const joinedText = allLines.join("\n");

  for (const pattern of INTENT_PATTERNS) {
    const matchCount = pattern.keywords.filter((kw) =>
      joinedText.includes(kw),
    ).length;
    // Require all keywords of the pattern to appear
    if (matchCount === pattern.keywords.length) {
      // Also require at least 2 edits to contain the pattern
      const editsWithPattern = recent.filter((e) =>
        pattern.keywords.some((kw) => e.lines.some((l) => l.includes(kw))),
      );
      if (editsWithPattern.length >= 2) {
        return pattern.intent;
      }
    }
  }

  // Check for symbol repetition across edits (same new symbol in 2+ edits)
  if (recent.length >= 2) {
    const symbolSets = recent.map((e) => e.symbols);
    for (const sym of symbolSets[0]) {
      if (sym.length < 3) continue; // skip short symbols
      const appearsInOthers = symbolSets
        .slice(1)
        .filter((s) => s.has(sym)).length;
      if (appearsInOthers >= 1) {
        return `working with '${sym}'`;
      }
    }
  }

  return undefined;
}

/**
 * Create a static snippet containing the edit intent, if detected.
 * This snippet has the highest information density per token.
 */
export function createEditIntentSnippet(
  recentEdits: RecentEdit[],
  filepath: string,
): AutocompleteStaticSnippet | undefined {
  const intent = detectEditIntent(recentEdits);
  if (!intent) return undefined;

  return {
    content: `Current editing pattern: ${intent}`,
    type: AutocompleteSnippetType.Static,
    filepath,
  };
}
