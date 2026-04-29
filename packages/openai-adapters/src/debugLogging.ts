const SECRET_KEY_PATTERN =
  /(authorization|api[-_]?key|x-api-key|access[-_]?token|refresh[-_]?token|secret|password|credential|secretAccessKey|accessKeyId)/i;
const MAX_DEBUG_STRING_LENGTH = 500;

function getTextLength(value: unknown): number {
  if (typeof value === "string") {
    return value.length;
  }
  if (Array.isArray(value)) {
    return value.reduce(
      (total, nestedValue) => total + getTextLength(nestedValue),
      0,
    );
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text.length;
    }
    if (typeof record.content === "string") {
      return record.content.length;
    }
    if (Array.isArray(record.content)) {
      return getTextLength(record.content);
    }
  }
  return 0;
}

function getContentSummary(content: unknown): Record<string, unknown> {
  if (typeof content === "string") {
    return {
      contentType: "string",
      textLength: content.length,
    };
  }

  if (Array.isArray(content)) {
    return {
      contentType: "array",
      partCount: content.length,
      partTypes: content.map((part: any) => part?.type ?? typeof part),
      textLength: getTextLength(content),
    };
  }

  return {
    contentType: content == null ? String(content) : typeof content,
    textLength: getTextLength(content),
  };
}

function getMessageSummaries(
  messages: unknown,
): Array<Record<string, unknown>> {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages.map((message: any, index) => ({
    ...getContentSummary(message?.content),
    index,
    role: message?.role,
    hasToolCalls:
      Array.isArray(message?.tool_calls) && message.tool_calls.length > 0,
    toolCallCount: Array.isArray(message?.tool_calls)
      ? message.tool_calls.length
      : 0,
    hasReasoning: Object.prototype.hasOwnProperty.call(
      message ?? {},
      "reasoning",
    ),
    hasReasoningContent: Object.prototype.hasOwnProperty.call(
      message ?? {},
      "reasoning_content",
    ),
    reasoningContentLength:
      typeof message?.reasoning_content === "string"
        ? message.reasoning_content.length
        : undefined,
    reasoningDetailsCount: Array.isArray(message?.reasoning_details)
      ? message.reasoning_details.length
      : 0,
  }));
}

function getStopCount(stop: unknown): number {
  return Array.isArray(stop) ? stop.length : stop ? 1 : 0;
}

function parseBodyForSummary(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function summarizeLlmRequestForDebug(
  value: unknown,
): Record<string, unknown> {
  const body = parseBodyForSummary(value) as any;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      bodyType: body == null ? String(body) : typeof body,
    };
  }

  const messageSummaries = getMessageSummaries(body.messages);
  const inputSummaries: Array<Record<string, unknown>> = Array.isArray(
    body.input,
  )
    ? body.input.map((input: any, index: number) => ({
        ...getContentSummary(input?.content ?? input),
        index,
        role: input?.role,
      }))
    : [];

  return {
    model: body.model,
    stream: body.stream,
    maxTokens: body.max_tokens,
    maxCompletionTokens: body.max_completion_tokens,
    maxOutputTokens: body.max_output_tokens,
    temperature: body.temperature,
    topP: body.top_p,
    reasoningEffort: body.reasoning_effort ?? body.reasoning?.effort,
    verbosity: body.verbosity ?? body.text?.verbosity,
    stopCount: getStopCount(body.stop),
    toolChoice: body.tool_choice,
    toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    parallelToolCalls: body.parallel_tool_calls,
    hasPrediction: Object.prototype.hasOwnProperty.call(body, "prediction"),
    hasStreamOptions: Object.prototype.hasOwnProperty.call(
      body,
      "stream_options",
    ),
    messageCount: messageSummaries.length,
    inputCount: inputSummaries.length,
    totalMessageTextLength: messageSummaries.reduce(
      (total, message) =>
        total +
        (typeof message.textLength === "number" ? message.textLength : 0),
      0,
    ),
    totalInputTextLength: inputSummaries.reduce(
      (total, input) =>
        total + (typeof input.textLength === "number" ? input.textLength : 0),
      0,
    ),
    messageSummaries,
    inputSummaries,
  };
}

function truncateStringForDebug(value: string): string {
  if (value.length <= MAX_DEBUG_STRING_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_DEBUG_STRING_LENGTH)}...<truncated ${value.length - MAX_DEBUG_STRING_LENGTH} chars>`;
}

function shouldRedactKey(key: string): boolean {
  // Never redact the fields we are explicitly debugging.
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

export function sanitizeForLlmDebug(value: unknown): unknown {
  return normalizeForDebug(value, new WeakSet<object>());
}

export function stringifyForLlmDebug(value: unknown): string {
  return JSON.stringify(sanitizeForLlmDebug(value), null, 2);
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
