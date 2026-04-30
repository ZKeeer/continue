import ignore from "ignore";

import { IDE } from "../..";
import {
  getGlobalContinueIgArray,
  getWorkspaceContinueIgArray,
} from "../../indexing/continueignore";
import { getConfigJsonPath } from "../../util/paths";
import { findUriInDirs } from "../../util/uri";
import { HelperVars } from "../util/HelperVars";

// [zkdev] Phase 2: Module-level cache for .continueignore patterns (avoids repeated IPC)
let _cachedWorkspaceIgArray: string[] | null = null;
let _cachedWorkspaceIgTimestamp = 0;
const WORKSPACE_IG_CACHE_TTL_MS = 30_000;

async function getCachedWorkspaceContinueIgArray(ide: IDE): Promise<string[]> {
  const now = Date.now();
  if (
    _cachedWorkspaceIgArray &&
    now - _cachedWorkspaceIgTimestamp < WORKSPACE_IG_CACHE_TTL_MS
  ) {
    return _cachedWorkspaceIgArray;
  }
  _cachedWorkspaceIgArray = await getWorkspaceContinueIgArray(ide);
  _cachedWorkspaceIgTimestamp = now;
  return _cachedWorkspaceIgArray;
}

function isDisabledForFile(
  currentFilepath: string,
  disableInFiles: string[] | undefined,
  workspaceDirs: string[],
) {
  if (disableInFiles) {
    const { relativePathOrBasename } = findUriInDirs(
      currentFilepath,
      workspaceDirs,
    );

    // @ts-ignore
    const pattern = ignore.default().add(disableInFiles);
    if (pattern.ignores(relativePathOrBasename)) {
      return true;
    }
  }
}

async function shouldLanguageSpecificPrefilter(helper: HelperVars) {
  const line = helper.fileLines[helper.pos.line] ?? "";
  for (const endOfLine of helper.lang.endOfLine) {
    if (line.endsWith(endOfLine) && helper.pos.character >= line.length) {
      return true;
    }
  }
}

export async function shouldPrefilter(
  helper: HelperVars,
  ide: IDE,
): Promise<boolean> {
  // Allow disabling autocomplete from config.json
  if (helper.options.disable) {
    return true;
  }

  // Check whether we're in the continue config.json file
  if (helper.filepath === getConfigJsonPath()) {
    return true;
  }

  // [zkdev] Phase 2: Use cached .continueignore + reuse helper.workspaceUris
  const disableInFiles = [
    ...(helper.options.disableInFiles ?? []),
    "*.prompt",
    ...getGlobalContinueIgArray(),
    ...(await getCachedWorkspaceContinueIgArray(ide)),
  ];
  if (
    isDisabledForFile(helper.filepath, disableInFiles, helper.workspaceUris)
  ) {
    return true;
  }

  // Don't offer completions when we have no information (untitled file and no file contents)
  if (
    helper.filepath.includes("Untitled") &&
    helper.fileContents.trim() === ""
  ) {
    return true;
  }

  // if (
  //   helper.options.transform &&
  //   (await shouldLanguageSpecificPrefilter(helper))
  // ) {
  //   return true;
  // }

  return false;
}
