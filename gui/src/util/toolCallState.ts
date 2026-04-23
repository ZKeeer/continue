import { ToolCallDelta, ToolCallState } from "core";
import { BuiltInToolNames } from "core/tools/builtIn";
import { incrementalParseJson } from "core/util/incrementalParseJson";

function summarizeArgKeys(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  return Object.keys(value as Record<string, unknown>).sort();
}

function previewText(value: string, maxLength = 160): string {
  return value.length > maxLength
    ? `${value.slice(0, maxLength)}...<truncated ${value.length - maxLength} chars>`
    : value;
}

// Merge streamed tool calls
// See example of data coming in here:
// https://platform.openai.com/docs/guides/function-calling?api-mode=chat#streaming
export function addToolCallDeltaToState(
  toolCallDelta: ToolCallDelta,
  currentState: ToolCallState | undefined,
): ToolCallState {
  const currentCall = currentState?.toolCall;

  // If we have a current state and the delta has a different ID, ignore the delta
  if (
    currentState &&
    toolCallDelta.id &&
    currentCall?.id !== toolCallDelta.id
  ) {
    return currentState;
  }

  // These will/should not be partially streamed
  const callType = toolCallDelta.type ?? "function";
  const callId = currentCall?.id || toolCallDelta.id || "";

  // These may be streamed in chunks
  const currentName = currentCall?.function.name ?? "";
  const currentArgs = currentCall?.function.arguments ?? "";

  const nameDelta = toolCallDelta.function?.name ?? "";
  const argsDelta = toolCallDelta.function?.arguments ?? "";
  const effectiveToolName = currentName || nameDelta || "";
  const shouldLogEditTool = isEditTool(effectiveToolName);

  let mergedName = currentName;
  if (nameDelta.startsWith(currentName)) {
    // Case where model progresssively streams name but full name each time e.g. "readFi" -> "readFil" -> "readFile"
    mergedName = nameDelta;
  } else if (!currentName.startsWith(nameDelta)) {
    mergedName = currentName + nameDelta;
  }

  // Similar logic for args, with an extra JSON check
  let mergedArgs = currentArgs;
  let currentArgsAlreadyComplete = false;
  try {
    // If args is JSON parseable, it is complete, don't add to it
    JSON.parse(currentArgs);
    currentArgsAlreadyComplete = true;
  } catch (e) {
    // Model streams in args in parts e.g. "{"file": "file1"" -> ", "line": 1}"
    mergedArgs = currentArgs + argsDelta;

    // Note, removed case where model progresssively streams args but full args each time e.g. "{"file": "file1"}" -> "{"file": "file1", "line": 1}"
    // Because no apis do this and difficult to detect reliably
  }

  const [isValidJson, parsedArgs] = incrementalParseJson(mergedArgs || "{}");

  if (shouldLogEditTool) {
    console.log("[ToolCallState] edit tool delta merge", {
      toolName: effectiveToolName,
      toolCallId: callId,
      providerIndex: currentState?.providerIndex ?? toolCallDelta.index,
      currentNameLength: currentName.length,
      nameDeltaLength: nameDelta.length,
      currentArgsLength: currentArgs.length,
      argsDeltaLength: argsDelta.length,
      currentArgsAlreadyComplete,
      mergedArgsLength: mergedArgs.length,
      isValidJson,
      parsedArgKeys: summarizeArgKeys(parsedArgs),
      hasFilepath:
        !!parsedArgs &&
        typeof parsedArgs === "object" &&
        "filepath" in (parsedArgs as Record<string, unknown>),
      hasChanges:
        !!parsedArgs &&
        typeof parsedArgs === "object" &&
        "changes" in (parsedArgs as Record<string, unknown>),
      argsDeltaPreview:
        typeof argsDelta === "string" ? previewText(argsDelta) : undefined,
      mergedArgsPreview: previewText(mergedArgs),
    });
  }

  const providerIndex = currentState?.providerIndex ?? toolCallDelta.index;

  return {
    status: "generating",
    toolCall: {
      id: callId,
      type: callType,
      function: {
        name: mergedName,
        arguments: mergedArgs,
      },
    },
    toolCallId: callId,
    parsedArgs,
    ...(providerIndex !== undefined ? { providerIndex } : {}),
  };
}

const editToolNames: string[] = [
  BuiltInToolNames.EditExistingFile,
  BuiltInToolNames.SingleFindAndReplace,
  BuiltInToolNames.MultiEdit,
];
export function isEditTool(toolName: string) {
  return editToolNames.includes(toolName);
}
