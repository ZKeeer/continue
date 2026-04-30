import QuickLRU from "quick-lru";

// The cache key and value are both a filepath string
export type cacheElementType = string;

// [zkdev] Reduced from 20 to 10 to cut context collection IO overhead
const MAX_NUM_OPEN_CONTEXT_FILES = 10;

// stores which files are currently open in the IDE, in viewing order
export const openedFilesLruCache = new QuickLRU<
  cacheElementType,
  cacheElementType
>({
  maxSize: MAX_NUM_OPEN_CONTEXT_FILES,
});

// used in core/core.ts to handle removals from the cache
export const prevFilepaths = {
  filepaths: [] as string[],
};
