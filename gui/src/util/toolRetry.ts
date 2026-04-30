/**
 * S-5 + A-7: Tool failure classification and transient-error retry policy.
 *
 * Transient failures (network, rate-limit, file-lock) are retried
 * automatically with exponential back-off.  Permanent failures (bad
 * arguments, missing file, schema mismatch, permissions) are passed back to
 * the LLM for correction — never retried at the system level.
 */

import { ContinueError, ContinueErrorReason } from "core/util/errors";

// ── A-7: Failure classification ───────────────────────────────────────────────

export enum ToolFailureClass {
  /** Network / rate-limit / server-side transient — safe to retry automatically */
  Transient = "transient",
  /** Bad arguments, missing file, schema mismatch — model must correct the call */
  Permanent = "permanent",
  /** Permission or security — do not retry, surface to user */
  PermissionFail = "permission_fail",
}

// ── S-5: Transient error detection ────────────────────────────────────────────

const TRANSIENT_PATTERNS: RegExp[] = [
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /ENOTFOUND/i,
  /fetch\s+failed/i,
  /network\s+error/i,
  /timed?\s*out/i,
  /rate[\s_-]?limit/i,
  /\b429\b/,
  /\b503\b/,
  /\b502\b/,
  /EBUSY/i, // Windows file-lock
  /temporarily\s+unavailable/i,
];

/** ContinueErrorReason values that are definitively permanent (model must fix the call). */
const PERMANENT_REASONS = new Set<ContinueErrorReason>([
  ContinueErrorReason.FindAndReplaceIdenticalOldAndNewStrings,
  ContinueErrorReason.FindAndReplaceMissingOldString,
  ContinueErrorReason.FindAndReplaceNonFirstEmptyOldString,
  ContinueErrorReason.FindAndReplaceMissingNewString,
  ContinueErrorReason.FindAndReplaceInvalidReplaceAll,
  ContinueErrorReason.FindAndReplaceOldStringNotFound,
  ContinueErrorReason.FindAndReplaceMultipleOccurrences,
  ContinueErrorReason.FindAndReplaceMissingFilepath,
  ContinueErrorReason.MultiEditEditsArrayRequired,
  ContinueErrorReason.MultiEditEditsArrayEmpty,
  ContinueErrorReason.MultiEditSubsequentEditsOnCreation,
  ContinueErrorReason.MultiEditEmptyOldStringNotFirst,
  ContinueErrorReason.EditToolFileNotRead,
  ContinueErrorReason.FileAlreadyExists,
  ContinueErrorReason.FileNotFound,
  ContinueErrorReason.FileIsSecurityConcern,
  ContinueErrorReason.ParentDirectoryNotFound,
  ContinueErrorReason.FileTooLarge,
  ContinueErrorReason.PathResolutionFailed,
  ContinueErrorReason.InvalidLineNumber,
  ContinueErrorReason.DirectoryNotFound,
  ContinueErrorReason.CommandNotAvailableInRemote,
]);

export function isTransientMessage(msg: string): boolean {
  return TRANSIENT_PATTERNS.some((p) => p.test(msg));
}

export function classifyToolError(
  error: ContinueError | Error,
): ToolFailureClass {
  if (error instanceof ContinueError) {
    if (PERMANENT_REASONS.has(error.reason)) {
      return ToolFailureClass.Permanent;
    }
    if (error.reason === ContinueErrorReason.FileWriteError) {
      // FileWriteError can be transient (file lock) or permanent (hard permissions)
      return isTransientMessage(error.message ?? "")
        ? ToolFailureClass.Transient
        : ToolFailureClass.PermissionFail;
    }
  }
  if (isTransientMessage(error.message ?? "")) {
    return ToolFailureClass.Transient;
  }
  return ToolFailureClass.Permanent;
}

// ── S-5: Retry policy ─────────────────────────────────────────────────────────

export const MAX_TOOL_RETRIES = 3;
const BASE_DELAY_MS = 500;

export function getRetryDelay(attemptIndex: number): number {
  // Exponential: 500 ms, 1000 ms, 2000 ms
  return BASE_DELAY_MS * Math.pow(2, attemptIndex);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
