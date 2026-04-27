const SECRET_KEY_PATTERN =
  /(authorization|api[-_]?key|x-api-key|access[-_]?token|refresh[-_]?token|secret|password|credential|secretAccessKey|accessKeyId)/i;
const MAX_DEBUG_STRING_LENGTH = 500;

function truncateStringForDebug(value: string): string {
  if (value.length <= MAX_DEBUG_STRING_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_DEBUG_STRING_LENGTH)}...<truncated ${value.length - MAX_DEBUG_STRING_LENGTH} chars>`;
}

function shouldRedactKey(key: string): boolean {
  // Keep reasoning/thinking fields intact for diagnostics.
  if (/reasoning|thinking/i.test(key)) {
    return false;
  }
  return SECRET_KEY_PATTERN.test(key);
}

function normalizeForDebug(value: unknown, seen: WeakSet<object>): unknown {
  if (value === undefined) {
    return "[undefined]";
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "string") {
    return truncateStringForDebug(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (value instanceof Error) {
    const errorRecord: Record<string, unknown> = {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
    for (const [key, nestedValue] of Object.entries(value as any)) {
      errorRecord[key] = shouldRedactKey(key)
        ? "[REDACTED]"
        : normalizeForDebug(nestedValue, seen);
    }
    return errorRecord;
  }

  if (value instanceof Map) {
    return Object.fromEntries(
      [...value.entries()].map(([key, nestedValue]) => [
        String(key),
        shouldRedactKey(String(key))
          ? "[REDACTED]"
          : normalizeForDebug(nestedValue, seen),
      ]),
    );
  }

  if (value instanceof Set) {
    return [...value.values()].map((nestedValue) =>
      normalizeForDebug(nestedValue, seen),
    );
  }

  if (Array.isArray(value)) {
    return value.map((nestedValue) => normalizeForDebug(nestedValue, seen));
  }

  if (typeof (value as any).forEach === "function") {
    const entries: Record<string, unknown> = {};
    try {
      (value as any).forEach((nestedValue: unknown, key: string) => {
        entries[key] = shouldRedactKey(key)
          ? "[REDACTED]"
          : normalizeForDebug(nestedValue, seen);
      });
      if (Object.keys(entries).length > 0) {
        return entries;
      }
    } catch {
      // Fall through to plain object handling.
    }
  }

  const record: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    record[key] = shouldRedactKey(key)
      ? "[REDACTED]"
      : normalizeForDebug(nestedValue, seen);
  }
  return record;
}

export function stringifyForLlmDebug(value: unknown): string {
  return JSON.stringify(
    normalizeForDebug(value, new WeakSet<object>()),
    null,
    2,
  );
}

export function isLlmDebugLoggingEnabled(): boolean {
  const value = process.env.CONTINUE_LLM_DEBUG_LOG?.toLowerCase();
  return value !== "0" && value !== "false" && value !== "off";
}

export function logLlmDebug(label: string, data: unknown): void {
  if (!isLlmDebugLoggingEnabled()) {
    return;
  }

  console.log(`[LLM_DEBUG] ${label}\n${stringifyForLlmDebug(data)}`);
}
