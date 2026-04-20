/**
 * Tracks consecutive tool call errors to detect and stop infinite retry loops.
 * Session-scoped — resets on page reload.
 */

const MAX_CONSECUTIVE_SAME_ERRORS = 3;

interface ErrorEntry {
  count: number;
  lastError: string;
}

const consecutiveErrors = new Map<string, ErrorEntry>();

function getErrorKey(toolName: string, errorMessage: string): string {
  // Use first 100 chars of error as signature (ignore dynamic parts like line numbers)
  return `${toolName}:${errorMessage.slice(0, 100)}`;
}

/**
 * Track a tool error occurrence. Returns the current consecutive count.
 */
export function trackToolError(toolName: string, errorMessage: string): number {
  const key = getErrorKey(toolName, errorMessage);
  const existing = consecutiveErrors.get(key);
  const count = (existing?.count || 0) + 1;
  consecutiveErrors.set(key, { count, lastError: errorMessage });
  return count;
}

/**
 * Clear error tracking for a tool (call on success).
 */
export function clearToolErrors(toolName: string): void {
  for (const key of consecutiveErrors.keys()) {
    if (key.startsWith(`${toolName}:`)) {
      consecutiveErrors.delete(key);
    }
  }
}

/**
 * Check if the error limit has been reached.
 */
export function hasReachedErrorLimit(
  toolName: string,
  errorMessage: string,
): boolean {
  const key = getErrorKey(toolName, errorMessage);
  const entry = consecutiveErrors.get(key);
  return (entry?.count || 0) >= MAX_CONSECUTIVE_SAME_ERRORS;
}

/**
 * Format an enhanced error message with retry context.
 */
export function formatEnhancedToolError(
  toolName: string,
  errorMessage: string,
  attemptNumber: number,
): string {
  let msg = `${toolName} failed with the message: ${errorMessage}`;

  if (attemptNumber > 1) {
    msg += `\n\n⚠️ This is attempt #${attemptNumber} with a similar error.`;
  }

  if (attemptNumber >= MAX_CONSECUTIVE_SAME_ERRORS) {
    msg += `\nYou have failed ${attemptNumber} times with similar errors. Stop retrying this approach and either try a completely different strategy or inform the user about the issue.`;
  } else {
    msg += `\nPlease analyze the error carefully and try a different approach.`;
  }

  return msg;
}

/**
 * Reset all error tracking (e.g., on new conversation).
 */
export function resetAllToolErrors(): void {
  consecutiveErrors.clear();
}
