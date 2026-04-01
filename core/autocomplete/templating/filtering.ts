import { estimateTokensFast } from "../../llm/countTokens";
import { SnippetPayload } from "../snippets";
import {
  AutocompleteCodeSnippet,
  AutocompleteSnippet,
  AutocompleteSnippetType,
  AutocompleteStaticSnippet,
} from "../snippets/types";
import { HelperVars } from "../util/HelperVars";
import { formatOpenedFilesContext } from "./formatOpenedFilesContext";

import { isValidSnippet } from "./validation";

const getRemainingTokenCount = (helper: HelperVars): number => {
  // [zkdev] Use fast char-based estimation (O(1)) instead of real tokenizer.
  // Exact budget is enforced later in renderPromptWithTokenLimit overflow check.
  const tokenCount = estimateTokensFast(helper.prunedCaretWindow);

  return helper.options.maxPromptTokens - tokenCount;
};

const TOKEN_BUFFER = 10; // We may need extra tokens for snippet description etc.

// [zkdev] Snippet source annotation — structured bracket format to avoid confusion
// with programming language comments. Format: [PROMPT: SOURCE_TYPE - PRIORITY_LEVEL]
// This format is language-agnostic and clearly distinguishable from code comments.
const SNIPPET_SOURCE_LABELS: Record<
  string,
  { label: string; priority: string }
> = {
  recentlyEditedRanges: { label: "RECENT_EDIT", priority: "HIGH" },
  recentlyVisitedRanges: { label: "RECENT_VISIT", priority: "HIGH" },
  recentlyOpenedFiles: { label: "OPEN_FILE", priority: "MEDIUM" },
  diff: { label: "GIT_DIFF", priority: "LOW" },
  base: { label: "DEFINITION", priority: "LOW" },
};

function annotateSnippetSource(
  snippet: AutocompleteSnippet,
  sourceKey: string,
): AutocompleteSnippet {
  if (snippet.type !== AutocompleteSnippetType.Code) return snippet;
  const meta = SNIPPET_SOURCE_LABELS[sourceKey];
  if (!meta) return snippet;
  const codeSnippet = snippet as AutocompleteCodeSnippet;
  // [zkdev] Bracket format: language-agnostic, won't clash with // # -- or /* */
  const annotation = `[PROMPT: ${meta.label} - ${meta.priority} PRIORITY]`;
  return { ...codeSnippet, content: `${annotation}\n${codeSnippet.content}` };
}

// [zkdev] AST-boundary aware snippet truncation
// Patterns that indicate the start of a top-level code block (function, class, etc.)
const BLOCK_START_PATTERN =
  /^(export\s+)?(function |class |interface |type |enum |const |let |var |def |async function |public |private |protected |abstract |\})/;

/**
 * [zkdev] Truncate snippet content at the last complete code block boundary
 * that fits within maxTokens. Falls back to raw token truncation if no boundary found.
 * Accepts optional countFn for P2 memoization support.
 */
function truncateAtBlockBoundary(
  content: string,
  maxTokens: number,
  modelName: string,
  countFn: (content: string, model: string) => number = (c) => estimateTokensFast(c),
): string {
  const tokens = countFn(content, modelName);
  if (tokens <= maxTokens) return content;

  const lines = content.split("\n");

  // Find the last block boundary that fits within budget
  let bestCutLine = -1;
  let runningContent = "";
  for (let i = 0; i < lines.length; i++) {
    const candidate = runningContent + (i > 0 ? "\n" : "") + lines[i];
    if (countFn(candidate, modelName) > maxTokens) break;
    runningContent = candidate;

    // Check if next line (if exists) starts a new block → this line is a good cut point
    if (
      i + 1 < lines.length &&
      BLOCK_START_PATTERN.test(lines[i + 1].trimStart())
    ) {
      bestCutLine = i;
    }
  }

  if (bestCutLine >= 0) {
    return lines.slice(0, bestCutLine + 1).join("\n");
  }

  // Fallback: just take lines that fit
  return runningContent;
}

// [zkdev] Stable sort by filepath for sglang prefix cache friendliness
// Previously used Fisher-Yates shuffle which destroyed ordering and hurt prefix cache hit rate
const sortByFilepath = <T extends { filepath?: string }>(array: T[]): T[] => {
  return array.sort((a, b) =>
    (a.filepath ?? "").localeCompare(b.filepath ?? ""),
  );
};

function filterSnippetsAlreadyInCaretWindow(
  snippets: (AutocompleteCodeSnippet | AutocompleteStaticSnippet)[],
  caretWindow: string,
): (AutocompleteCodeSnippet | AutocompleteStaticSnippet)[] {
  return snippets.filter(
    (s) => s.content.trim() !== "" && !caretWindow.includes(s.content.trim()),
  );
}

// [zkdev] P1: Overlap-aware dedup — calculate overlap ratio between two line ranges.
// Returns fraction of the candidate range that overlaps with an existing range (0..1).
function lineRangeOverlap(
  candidateStart: number,
  candidateEnd: number,
  existingRanges: Array<{ start: number; end: number }>,
): number {
  const candidateLen = candidateEnd - candidateStart + 1;
  if (candidateLen <= 0) return 0;
  let overlapLines = 0;
  for (const { start, end } of existingRanges) {
    const overlapStart = Math.max(candidateStart, start);
    const overlapEnd = Math.min(candidateEnd, end);
    if (overlapStart <= overlapEnd) {
      overlapLines += overlapEnd - overlapStart + 1;
    }
  }
  return Math.min(overlapLines / candidateLen, 1);
}

export const getSnippets = (
  helper: HelperVars,
  payload: SnippetPayload,
): AutocompleteSnippet[] => {
  // [zkdev] Use fast char-based estimation (O(1)) for all snippet budget calculations.
  // Real tokenizer (llamaTokenizer) was adding 200-400ms per prompt build.
  // Overflow is caught by renderPromptWithTokenLimit safety net.
  const cachedCountTokens = (content: string, _modelName: string): number => {
    return estimateTokensFast(content);
  };
  const snippets = {
    clipboard: payload.clipboardSnippets,
    recentlyVisitedRanges: payload.recentlyVisitedRangesSnippets,
    recentlyEditedRanges: payload.recentlyEditedRangeSnippets,
    diff: payload.diffSnippets,
    recentlyOpenedFiles: payload.recentlyOpenedFileSnippets,
    base: sortByFilepath(
      filterSnippetsAlreadyInCaretWindow(
        [
          ...payload.rootPathSnippets,
          ...payload.importDefinitionSnippets,
          ...payload.staticSnippet,
        ],
        helper.prunedCaretWindow,
      ),
    ),
  };

  // Define snippets with their priorities
  const snippetConfigs: {
    key: keyof typeof snippets;
    enabledOrPriority: boolean | number;
    defaultPriority: number;
    snippets: AutocompleteSnippet[];
  }[] = [
    // [zkdev] Priority reorder: editedRanges(1) > visitedRanges(2) > openedFiles(3)
    // Rationale: recently edited code is the strongest relevance signal;
    // visitedRanges provide cursor-aware context from tabs (±20 lines around last cursor),
    // which replaces full-file fallback via filepath dedup in formatOpenedFilesContext;
    // openedFiles fills in remaining unvisited tabs with full-file content.
    {
      key: "recentlyEditedRanges",
      enabledOrPriority:
        helper.options.experimental_includeRecentlyEditedRanges,
      defaultPriority: 1,
      snippets: payload.recentlyEditedRangeSnippets,
    },
    {
      key: "recentlyVisitedRanges",
      enabledOrPriority:
        helper.options.experimental_includeRecentlyVisitedRanges,
      defaultPriority: 2,
      snippets: payload.recentlyVisitedRangesSnippets,
      // Note: also captures terminal/output if visible — filtered by VSCode layer
    },
    {
      key: "recentlyOpenedFiles",
      enabledOrPriority: helper.options.useRecentlyOpened,
      defaultPriority: 3,
      snippets: payload.recentlyOpenedFileSnippets,
    },
    {
      key: "clipboard",
      enabledOrPriority: helper.options.experimental_includeClipboard,
      defaultPriority: 90,
      snippets: payload.clipboardSnippets,
    },
    {
      key: "diff",
      enabledOrPriority: helper.options.experimental_includeDiff,
      defaultPriority: 98,
      snippets: payload.diffSnippets,
    },
    {
      key: "base",
      enabledOrPriority: true,
      defaultPriority: 99, // make sure it's the last one to be processed, but still possible to override
      snippets: sortByFilepath(
        filterSnippetsAlreadyInCaretWindow(
          [
            ...payload.rootPathSnippets,
            ...payload.importDefinitionSnippets,
            ...payload.staticSnippet,
          ],
          helper.prunedCaretWindow,
        ),
      ),
      // [zkdev] Moved from shuffleArray to sortByFilepath for stable sglang prefix cache
    },
  ];

  // Create a readable order of enabled snippets
  const snippetOrder = snippetConfigs
    .filter(({ enabledOrPriority }) => enabledOrPriority)
    .map(({ key, enabledOrPriority, defaultPriority }) => ({
      key,
      priority:
        typeof enabledOrPriority === "number"
          ? enabledOrPriority
          : defaultPriority,
    }))
    .sort((a, b) => a.priority - b.priority);

  const finalSnippets: AutocompleteSnippet[] = [];
  let remainingTokenCount = getRemainingTokenCount(helper);

  // [zkdev] P1: Base token floor — reserve 15% of snippet budget for structural context
  // (import definitions, root path context, static snippets). Prevents base from being
  // starved when editedRanges + visitedRanges + openedFiles consume most of the budget.
  const totalSnippetBudget = remainingTokenCount;
  const BASE_FLOOR_RATIO = 0.15;
  const baseFloor = Math.floor(totalSnippetBudget * BASE_FLOOR_RATIO);

  // tracks already added filepaths for deduplication
  const addedFilepaths = new Set<string>();
  // [zkdev] Track editedRanges filepaths separately so visitedRanges can still
  // add cursor context from the same file (edited snippet is small, cursor
  // context provides broader surrounding code — they are complementary)
  const editedRangesFilepaths = new Set<string>();

  // [zkdev] P1: Track line ranges per file for overlap-aware dedup between
  // editedRanges and visitedRanges (prevents duplicate content injection)
  const editedLineRanges = new Map<
    string,
    Array<{ start: number; end: number }>
  >();

  // Process snippets in priority order
  // [zkdev] Track group boundaries for sglang KV cache reordering
  const groupBoundaries: { key: string; startIdx: number }[] = [];
  for (const { key } of snippetOrder) {
    groupBoundaries.push({ key, startIdx: finalSnippets.length });
    // [zkdev] P1: Base floor — for non-base types, effective budget reserves baseFloor for base.
    // effectiveBudget = how many tokens this key can still use.
    const effectiveBudget =
      key === "base" ? remainingTokenCount : remainingTokenCount - baseFloor;
    if (effectiveBudget <= 0) continue;

    // Special handling for recentlyOpenedFiles
    if (key === "recentlyOpenedFiles" && helper.options.useRecentlyOpened) {
      // Custom trimming — budget is capped by base floor
      const processedSnippets = formatOpenedFilesContext(
        payload.recentlyOpenedFileSnippets,
        effectiveBudget,
        helper,
        finalSnippets,
        TOKEN_BUFFER,
      ).map((s) => annotateSnippetSource(s, key));

      // Add processed snippets to finalSnippets respecting token limits
      for (const snippet of processedSnippets) {
        if (!isValidSnippet(snippet)) continue;

        const snippetSize =
          cachedCountTokens(snippet.content, helper.modelName) + TOKEN_BUFFER;

        // [zkdev] Respect base floor — recentlyOpenedFiles is non-base, reserve baseFloor
        if (remainingTokenCount - baseFloor >= snippetSize) {
          finalSnippets.push(snippet);
          if (snippet.type === AutocompleteSnippetType.Code) {
            addedFilepaths.add((snippet as AutocompleteCodeSnippet).filepath);
          }
          remainingTokenCount -= snippetSize;
        } else {
          continue; // Not enough tokens, try again with next snippet
        }
      }
    } else {
      // Normal processing for other snippet types
      const snippetsToProcess = snippets[key]
        .filter((snippet) => {
          if (snippet.type !== AutocompleteSnippetType.Code) return true;
          const codeSnippet = snippet as AutocompleteCodeSnippet;
          if (!addedFilepaths.has(codeSnippet.filepath)) return true;
          // [zkdev] P1: Overlap-aware dedup — allow visitedRanges from same file as
          // editedRanges, but only if line overlap < 50% (prevents redundant content)
          if (
            key === "recentlyVisitedRanges" &&
            editedRangesFilepaths.has(codeSnippet.filepath)
          ) {
            const existingRanges = editedLineRanges.get(codeSnippet.filepath);
            if (!existingRanges || existingRanges.length === 0) return true;
            if (codeSnippet.startLine != null && codeSnippet.endLine != null) {
              return (
                lineRangeOverlap(
                  codeSnippet.startLine,
                  codeSnippet.endLine,
                  existingRanges,
                ) < 0.5
              );
            }
            return true; // No line range info → allow (backward compat)
          }
          return false;
        })
        .map((s) => annotateSnippetSource(s, key));

      // [zkdev] Limit diff snippets to 30% of total snippet budget to prevent crowding out
      // import definitions and root path context which are typically higher value
      const maxKeyTokens =
        key === "diff"
          ? Math.floor(getRemainingTokenCount(helper) * 0.3)
          : Infinity;
      let keyTokensUsed = 0;

      for (const snippet of snippetsToProcess) {
        if (!isValidSnippet(snippet)) continue;

        const snippetSize =
          cachedCountTokens(snippet.content, helper.modelName) + TOKEN_BUFFER;

        // [zkdev] P1: Respect base floor for non-base types
        const budgetForThis =
          key === "base"
            ? remainingTokenCount
            : remainingTokenCount - baseFloor;

        if (keyTokensUsed + snippetSize > maxKeyTokens) {
          // [zkdev] Try AST-boundary truncation instead of skipping entirely
          const budgetLeft = maxKeyTokens - keyTokensUsed - TOKEN_BUFFER;
          if (
            budgetLeft > 50 &&
            snippet.type === AutocompleteSnippetType.Code
          ) {
            const truncated = truncateAtBlockBoundary(
              snippet.content,
              budgetLeft,
              helper.modelName,
              cachedCountTokens,
            );
            if (truncated.length > 0 && truncated !== snippet.content) {
              const truncSize =
                cachedCountTokens(truncated, helper.modelName) + TOKEN_BUFFER;
              const truncBudget =
                key === "base"
                  ? remainingTokenCount
                  : remainingTokenCount - baseFloor;
              if (truncBudget >= truncSize) {
                finalSnippets.push({ ...snippet, content: truncated });
                if ((snippet as AutocompleteCodeSnippet).filepath) {
                  addedFilepaths.add(
                    (snippet as AutocompleteCodeSnippet).filepath,
                  );
                  if (key === "recentlyEditedRanges") {
                    editedRangesFilepaths.add(
                      (snippet as AutocompleteCodeSnippet).filepath,
                    );
                    // [zkdev] P1: Record line range for overlap-aware dedup
                    const cs = snippet as AutocompleteCodeSnippet;
                    if (cs.startLine != null && cs.endLine != null) {
                      const ranges = editedLineRanges.get(cs.filepath) || [];
                      ranges.push({ start: cs.startLine, end: cs.endLine });
                      editedLineRanges.set(cs.filepath, ranges);
                    }
                  }
                }
                remainingTokenCount -= truncSize;
                keyTokensUsed += truncSize;
              }
            }
          }
          continue;
        }

        if (budgetForThis >= snippetSize) {
          finalSnippets.push(snippet);

          if ((snippet as AutocompleteCodeSnippet).filepath) {
            addedFilepaths.add((snippet as AutocompleteCodeSnippet).filepath);
            if (key === "recentlyEditedRanges") {
              editedRangesFilepaths.add(
                (snippet as AutocompleteCodeSnippet).filepath,
              );
              // [zkdev] P1: Record line range for overlap-aware dedup
              const cs = snippet as AutocompleteCodeSnippet;
              if (cs.startLine != null && cs.endLine != null) {
                const ranges = editedLineRanges.get(cs.filepath) || [];
                ranges.push({ start: cs.startLine, end: cs.endLine });
                editedLineRanges.set(cs.filepath, ranges);
              }
            }
          }

          remainingTokenCount -= snippetSize;
          keyTokensUsed += snippetSize;
        } else {
          // [zkdev] AST-boundary truncation for snippets that exceed remaining global budget
          const truncBudget =
            key === "base"
              ? remainingTokenCount
              : remainingTokenCount - baseFloor;
          if (
            truncBudget > 50 + TOKEN_BUFFER &&
            snippet.type === AutocompleteSnippetType.Code
          ) {
            const truncated = truncateAtBlockBoundary(
              snippet.content,
              truncBudget - TOKEN_BUFFER,
              helper.modelName,
              cachedCountTokens,
            );
            if (truncated.length > 0 && truncated !== snippet.content) {
              const truncSize =
                cachedCountTokens(truncated, helper.modelName) + TOKEN_BUFFER;
              finalSnippets.push({ ...snippet, content: truncated });
              if ((snippet as AutocompleteCodeSnippet).filepath) {
                addedFilepaths.add(
                  (snippet as AutocompleteCodeSnippet).filepath,
                );
                if (key === "recentlyEditedRanges") {
                  editedRangesFilepaths.add(
                    (snippet as AutocompleteCodeSnippet).filepath,
                  );
                  const cs = snippet as AutocompleteCodeSnippet;
                  if (cs.startLine != null && cs.endLine != null) {
                    const ranges = editedLineRanges.get(cs.filepath) || [];
                    ranges.push({ start: cs.startLine, end: cs.endLine });
                    editedLineRanges.set(cs.filepath, ranges);
                  }
                }
              }
              remainingTokenCount -= truncSize;
              keyTokensUsed += truncSize;
            }
          }
          continue;
        }
      }
    }

    // If we're out of tokens, no need to process more snippet types
    if (remainingTokenCount <= 0) break;
  }

  // [zkdev] Reorder for sglang KV cache prefix reuse:
  // Low-frequency snippets (base/DEFINITION) → front of prompt (cached across requests)
  // High-frequency snippets (RECENT_EDIT) → end of prompt (near FIM point, changes often)
  // Token budget allocation by priority is unchanged — only final output order reverses.
  const reorderedSnippets: AutocompleteSnippet[] = [];
  for (let i = groupBoundaries.length - 1; i >= 0; i--) {
    const start = groupBoundaries[i].startIdx;
    const end =
      i + 1 < groupBoundaries.length
        ? groupBoundaries[i + 1].startIdx
        : finalSnippets.length;
    const groupSnippets = finalSnippets.slice(start, end);
    // [zkdev] Within RECENT_EDIT: reverse to oldest-first for stable prefix
    if (groupBoundaries[i].key === "recentlyEditedRanges") {
      groupSnippets.reverse();
    }
    reorderedSnippets.push(...groupSnippets);
  }

  // [zkdev] Log which snippets made it into the final prompt after filtering/budget
  console.log(
    `[Autocomplete FilterResult] finalSnippets=${reorderedSnippets.length} ` +
      `usedTokens=${totalSnippetBudget - remainingTokenCount}/${totalSnippetBudget} ` +
      `snippetSources=[${reorderedSnippets
        .map((s) => {
          if (s.type === AutocompleteSnippetType.Code) {
            const cs = s as AutocompleteCodeSnippet;
            return cs.filepath.split("/").pop();
          }
          return s.type;
        })
        .join(",")}]`,
  );

  return reorderedSnippets;
};
