import { IDE } from "../../index";
import { findUriInDirs, getUriPathBasename } from "../../util/uri";
import { ContextRetrievalService } from "../context/ContextRetrievalService";
import { GetLspDefinitionsFunction } from "../types";
import { HelperVars } from "../util/HelperVars";
import { openedFilesLruCache } from "../util/openedFilesLruCache";
import { getDiffsFromCache } from "./gitDiffCache";

import {
  AutocompleteClipboardSnippet,
  AutocompleteCodeSnippet,
  AutocompleteDiffSnippet,
  AutocompleteSnippetType,
  AutocompleteStaticSnippet,
} from "./types";

import { createEditIntentSnippet } from "../prediction/EditIntentDetector.js";

const IDE_SNIPPETS_ENABLED = false; // ideSnippets is not used, so it's temporarily disabled

export interface SnippetPayload {
  rootPathSnippets: AutocompleteCodeSnippet[];
  importDefinitionSnippets: AutocompleteCodeSnippet[];
  ideSnippets: AutocompleteCodeSnippet[];
  recentlyEditedRangeSnippets: AutocompleteCodeSnippet[];
  recentlyVisitedRangesSnippets: AutocompleteCodeSnippet[];
  diffSnippets: AutocompleteDiffSnippet[];
  clipboardSnippets: AutocompleteClipboardSnippet[];
  recentlyOpenedFileSnippets: AutocompleteCodeSnippet[];
  staticSnippet: AutocompleteStaticSnippet[];
}

// [zkdev] Concurrency limiter for LSP/IO requests
// racePromise only abandons waiting — it does NOT cancel the underlying work.
// Without a concurrency limit, fast typing can pile up unbounded background requests.
let _pendingSnippetRequests = 0;
const MAX_PENDING_SNIPPET_REQUESTS = 3;
const SLOT_SAFETY_TIMEOUT_MS = 30_000; // Failsafe: release slot after 30s even if promise never settles

function racePromise<T>(promise: Promise<T[]>, timeout = 100): Promise<T[]> {
  // If too many requests are already in-flight, return empty immediately
  if (_pendingSnippetRequests >= MAX_PENDING_SNIPPET_REQUESTS) {
    return Promise.resolve([]);
  }

  _pendingSnippetRequests++;
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      _pendingSnippetRequests = Math.max(0, _pendingSnippetRequests - 1);
    }
  };

  // Release slot when the underlying promise settles (best case)
  promise.then(release, release);

  // Failsafe: release slot after 30s even if promise never settles (e.g. LSP hung)
  setTimeout(release, SLOT_SAFETY_TIMEOUT_MS);

  const timeoutPromise = new Promise<T[]>((resolve) => {
    setTimeout(() => resolve([]), timeout);
  });

  return Promise.race([promise, timeoutPromise]);
}

// Some IDEs might have special ways of finding snippets (e.g. JetBrains and VS Code have different "LSP-equivalent" systems,
// or they might separately track recently edited ranges)
async function getIdeSnippets(
  helper: HelperVars,
  ide: IDE,
  getDefinitionsFromLsp: GetLspDefinitionsFunction,
): Promise<AutocompleteCodeSnippet[]> {
  const ideSnippets = await getDefinitionsFromLsp(
    helper.input.filepath,
    helper.fullPrefix + helper.fullSuffix,
    helper.fullPrefix.length,
    ide,
    helper.lang,
  );

  if (helper.options.onlyMyCode) {
    const workspaceDirs = await ide.getWorkspaceDirs();

    return ideSnippets.filter((snippet) =>
      workspaceDirs.some(
        (dir) => !!findUriInDirs(snippet.filepath, [dir]).foundInDir,
      ),
    );
  }

  return ideSnippets;
}

function getSnippetsFromRecentlyEditedRanges(
  helper: HelperVars,
): AutocompleteCodeSnippet[] {
  if (helper.options.useRecentlyEdited === false) {
    return [];
  }

  return helper.input.recentlyEditedRanges
    .filter(
      (range) => findUriInDirs(range.filepath, helper.workspaceUris).foundInDir,
    )
    .map((range) => {
      return {
        filepath: range.filepath,
        content: range.lines.join("\n"),
        type: AutocompleteSnippetType.Code,
        // [zkdev] Propagate line range for overlap-aware dedup in filtering.ts
        startLine: range.range.start.line,
        endLine: range.range.end.line,
      };
    });
}

const getClipboardSnippets = async (
  ide: IDE,
): Promise<AutocompleteClipboardSnippet[]> => {
  const content = await ide.getClipboardContent();

  return [content].map((item) => {
    return {
      content: item.text,
      copiedAt: item.copiedAt,
      type: AutocompleteSnippetType.Clipboard,
    };
  });
};

const getDiffSnippets = async (
  ide: IDE,
): Promise<AutocompleteDiffSnippet[]> => {
  const diffs = await getDiffsFromCache(ide);

  return diffs.map((item) => {
    return {
      content: item,
      type: AutocompleteSnippetType.Diff,
    };
  });
};

/**
 * [zkdev] P2-12: Only get diff for the current file to avoid large repo diff overhead.
 * Filters cached diffs by matching the current file's relative path or basename
 * against unified diff headers. Budget-limited to ~800 chars (~200 tokens).
 */
const getDiffSnippetsForCurrentFile = async (
  ide: IDE,
  filepath: string,
  workspaceDirs: string[],
): Promise<AutocompleteDiffSnippet[]> => {
  const diffs = await getDiffsFromCache(ide);
  if (diffs.length === 0) {
    return [];
  }

  const { relativePathOrBasename } = findUriInDirs(filepath, workspaceDirs);
  const basename = getUriPathBasename(filepath);

  const currentFileDiffs = diffs.filter((diff) => {
    return diff.includes(relativePathOrBasename) || diff.includes(basename);
  });

  if (currentFileDiffs.length === 0) {
    return [];
  }

  // ~400 tokens ≈ 1600 chars; truncate on line boundary to avoid partial lines
  const allLines = currentFileDiffs.join("\n").split("\n");
  let charCount = 0;
  const budgetLines: string[] = [];
  for (const line of allLines) {
    if (charCount + line.length + 1 > 1600) {
      break;
    }
    budgetLines.push(line);
    charCount += line.length + 1;
  }

  if (budgetLines.length === 0) {
    return [];
  }

  return [
    {
      content: budgetLines.join("\n"),
      type: AutocompleteSnippetType.Diff,
    },
  ];
};

const getSnippetsFromRecentlyOpenedFiles = async (
  helper: HelperVars,
  ide: IDE,
): Promise<AutocompleteCodeSnippet[]> => {
  if (helper.options.useRecentlyOpened === false) {
    return [];
  }

  try {
    const currentFileUri = `${helper.filepath}`;

    // Get all file URIs excluding the current file
    const fileUrisToRead = [...openedFilesLruCache.entriesDescending()]
      .filter(([fileUri, _]) => fileUri !== currentFileUri)
      .map(([fileUri, _]) => fileUri);

    // Create an array of promises that each read a file with timeout
    const fileReadPromises = fileUrisToRead.map((fileUri) => {
      // Create a promise that resolves to a snippet or null
      const readPromise = new Promise<AutocompleteCodeSnippet | null>(
        (resolve) => {
          ide
            .readFile(fileUri)
            .then((fileContent) => {
              if (!fileContent || fileContent.trim() === "") {
                resolve(null);
                return;
              }

              resolve({
                filepath: fileUri,
                content: fileContent,
                type: AutocompleteSnippetType.Code,
              });
            })
            .catch((e) => {
              console.error(`Failed to read file ${fileUri}:`, e);
              resolve(null);
            });
        },
      );
      // Cut off at 80ms via racing promises
      return Promise.race([
        readPromise,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 80)),
      ]);
    });

    // Execute all file reads in parallel
    const results = await Promise.all(fileReadPromises);

    // Filter out null results
    return results.filter(Boolean) as AutocompleteCodeSnippet[];
  } catch (e) {
    console.error("Error processing opened files cache:", e);
    return [];
  }
};

export const getAllSnippets = async ({
  helper,
  ide,
  getDefinitionsFromLsp,
  contextRetrievalService,
}: {
  helper: HelperVars;
  ide: IDE;
  getDefinitionsFromLsp: GetLspDefinitionsFunction;
  contextRetrievalService: ContextRetrievalService;
}): Promise<SnippetPayload> => {
  const recentlyEditedRangeSnippets =
    getSnippetsFromRecentlyEditedRanges(helper);

  const [
    rootPathSnippets,
    importDefinitionSnippets,
    ideSnippets,
    diffSnippets,
    clipboardSnippets,
    recentlyOpenedFileSnippets,
    staticSnippet,
  ] = await Promise.all([
    racePromise(contextRetrievalService.getRootPathSnippets(helper)),
    racePromise(
      contextRetrievalService.getSnippetsFromImportDefinitions(helper),
    ),
    IDE_SNIPPETS_ENABLED
      ? racePromise(getIdeSnippets(helper, ide, getDefinitionsFromLsp))
      : [],
    racePromise(
      getDiffSnippetsForCurrentFile(ide, helper.filepath, helper.workspaceUris),
      200,
    ), // [zkdev] P2-12: current file diff only, 200ms timeout
    racePromise(getClipboardSnippets(ide)),
    racePromise(getSnippetsFromRecentlyOpenedFiles(helper, ide)), // giving this one a little more time to complete
    helper.options.experimental_enableStaticContextualization
      ? racePromise(contextRetrievalService.getStaticContextSnippets(helper))
      : [],
  ]);

  // [zkdev] P1: Edit intent detection — gated behind experiment flag
  const editIntentSnippet = helper.options
    .experimental_enableEditIntentDetection
    ? createEditIntentSnippet(
        helper.input.recentlyEditedRanges,
        helper.filepath,
      )
    : undefined;
  const allStaticSnippets: AutocompleteStaticSnippet[] = [
    ...staticSnippet,
    ...(editIntentSnippet ? [editIntentSnippet] : []),
  ];

  return {
    rootPathSnippets,
    importDefinitionSnippets,
    ideSnippets,
    recentlyEditedRangeSnippets,
    diffSnippets,
    clipboardSnippets,
    recentlyVisitedRangesSnippets: helper.input.recentlyVisitedRanges.filter(
      (s) => findUriInDirs(s.filepath, helper.workspaceUris).foundInDir,
    ),
    recentlyOpenedFileSnippets,
    staticSnippet: allStaticSnippets,
  };
};

export const getAllSnippetsWithoutRace = async ({
  helper,
  ide,
  getDefinitionsFromLsp,
  contextRetrievalService,
}: {
  helper: HelperVars;
  ide: IDE;
  getDefinitionsFromLsp: GetLspDefinitionsFunction;
  contextRetrievalService: ContextRetrievalService;
}): Promise<SnippetPayload> => {
  const recentlyEditedRangeSnippets =
    getSnippetsFromRecentlyEditedRanges(helper);

  // [zkdev] Added racePromise(200ms) to prevent 1600ms+ spikes from slow LSP/IO
  const [
    rootPathSnippets,
    importDefinitionSnippets,
    ideSnippets,
    diffSnippets,
    clipboardSnippets,
    recentlyOpenedFileSnippets,
    staticSnippet,
  ] = await Promise.all([
    racePromise(contextRetrievalService.getRootPathSnippets(helper), 200),
    racePromise(
      contextRetrievalService.getSnippetsFromImportDefinitions(helper),
      200,
    ),
    IDE_SNIPPETS_ENABLED
      ? racePromise(getIdeSnippets(helper, ide, getDefinitionsFromLsp), 200)
      : [],
    racePromise(
      getDiffSnippetsForCurrentFile(ide, helper.filepath, helper.workspaceUris),
      200,
    ), // [zkdev] P2-12: current file diff only, 200ms timeout
    racePromise(getClipboardSnippets(ide), 200),
    racePromise(getSnippetsFromRecentlyOpenedFiles(helper, ide), 200),
    helper.options.experimental_enableStaticContextualization
      ? racePromise(
          contextRetrievalService.getStaticContextSnippets(helper),
          200,
        )
      : [],
  ]);

  // [zkdev] P1: Edit intent detection — gated behind experiment flag
  const editIntentSnippet2 = helper.options
    .experimental_enableEditIntentDetection
    ? createEditIntentSnippet(
        helper.input.recentlyEditedRanges,
        helper.filepath,
      )
    : undefined;
  const allStaticSnippets2: AutocompleteStaticSnippet[] = [
    ...staticSnippet,
    ...(editIntentSnippet2 ? [editIntentSnippet2] : []),
  ];

  const result: SnippetPayload = {
    rootPathSnippets,
    importDefinitionSnippets,
    ideSnippets,
    recentlyEditedRangeSnippets,
    diffSnippets,
    clipboardSnippets,
    recentlyVisitedRangesSnippets: helper.input.recentlyVisitedRanges.filter(
      (s) => findUriInDirs(s.filepath, helper.workspaceUris).foundInDir,
    ),
    recentlyOpenedFileSnippets,
    staticSnippet: allStaticSnippets2,
  };

  // [zkdev] Snippet source count log — helps verify which sources provided context
  console.log(
    `[Autocomplete SnippetCounts] ` +
      `edited=${recentlyEditedRangeSnippets.length} ` +
      `visited=${helper.input.recentlyVisitedRanges.length} ` +
      `opened=${recentlyOpenedFileSnippets.length} ` +
      `rootPath=${rootPathSnippets.length} ` +
      `importDef=${importDefinitionSnippets.length} ` +
      `static=${allStaticSnippets2.length} ` +
      `diff=${diffSnippets.length} ` +
      `clipboard=${clipboardSnippets.length}` +
      (helper.input.recentlyVisitedRanges.length > 0
        ? ` visitedFiles=[${helper.input.recentlyVisitedRanges.map((s) => s.filepath.split("/").pop()).join(",")}]`
        : ""),
  );

  return result;
};
