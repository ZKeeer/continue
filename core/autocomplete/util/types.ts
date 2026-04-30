import { Position, Range, RangeInFile, TabAutocompleteOptions } from "../..";
import { AutocompleteCodeSnippet } from "../snippets/types";

export type RecentlyEditedRange = RangeInFile & {
  timestamp: number;
  lines: string[];
  symbols: Set<string>;
};

export interface AutocompleteInput {
  isUntitledFile: boolean;
  completionId: string;
  filepath: string;
  pos: Position;
  recentlyVisitedRanges: AutocompleteCodeSnippet[];
  recentlyEditedRanges: RecentlyEditedRange[];
  // Used for notebook files
  manuallyPassFileContents?: string;
  // Used for VS Code git commit input box
  manuallyPassPrefix?: string;
  selectedCompletionInfo?: {
    text: string;
    range: Range;
  };
  injectDetails?: string;
}

export interface AutocompleteStageTimings {
  prepareLlmMs: number;
  debounceMs: number;
  contextCollectionMs: number;
  promptBuildMs: number;
  streamCompletionMs: number;
  postProcessMs: number;
}

export interface AutocompleteOutcome extends TabAutocompleteOptions {
  accepted?: boolean;
  time: number;
  stageTimings?: AutocompleteStageTimings;
  /** Compiled prefix (after template/snippet injection) — used for prompt, NOT for caching */
  prefix: string;
  /** Compiled suffix (after template injection) — used for prompt, NOT for caching */
  suffix: string;
  /** Raw document prefix (before template compilation) — used as stable cache key */
  documentPrefix: string;
  /** Raw document suffix (before template compilation) */
  documentSuffix: string;
  prompt: string;
  completion: string;
  modelProvider: string;
  modelName: string;
  completionOptions: any;
  cacheHit: boolean;
  numLines: number;
  filepath: string;
  gitRepo?: string;
  completionId: string;
  uniqueId: string;
  timestamp: string;
  enabledStaticContextualization?: boolean;
  profileType?: "local" | "platform" | "control-plane";
}
