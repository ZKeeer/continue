import { createAsyncThunk, unwrapResult } from "@reduxjs/toolkit";
import { ContextItem, McpUiState } from "core";
import { BuiltInToolNames, CLIENT_TOOLS_IMPLS } from "core/tools/builtIn";
import { ContinueError, ContinueErrorReason } from "core/util/errors";
import posthog from "posthog-js";
import { callClientTool } from "../../util/clientTools/callClientTool";
import {
  clearToolErrors,
  formatEnhancedToolError,
  hasReachedErrorLimit,
  trackToolError,
} from "../../util/toolErrorTracker";
import {
  MAX_TOOL_RETRIES,
  ToolFailureClass,
  classifyToolError,
  getRetryDelay,
  isTransientMessage,
  sleep,
} from "../../util/toolRetry";
import { selectSelectedChatModel } from "../slices/configSlice";
import {
  acceptToolCall,
  errorToolCall,
  setInactive,
  setToolCallCalling,
  updateToolCallOutput,
} from "../slices/sessionSlice";
import { ThunkApiType } from "../store";
import { findToolCallById, logToolUsage } from "../util";
import { streamResponseAfterToolCall } from "./streamResponseAfterToolCall";

// S-4: Tools that modify files and therefore require automatic post-edit verification
const EDIT_TOOL_NAMES = new Set<string>([
  BuiltInToolNames.EditExistingFile,
  BuiltInToolNames.CreateNewFile,
  BuiltInToolNames.MultiEdit,
  BuiltInToolNames.SingleFindAndReplace,
]);

export const callToolById = createAsyncThunk<
  void,
  { toolCallId: string; isAutoApproved?: boolean; depth?: number },
  ThunkApiType
>("chat/callTool", async (inputs, { dispatch, extra, getState }) => {
  const { toolCallId, isAutoApproved, depth = 0 } = inputs;

  const state = getState();
  const toolCallState = findToolCallById(state.session.history, toolCallId);
  if (!toolCallState) {
    console.warn(`Tool call with ID ${toolCallId} not found`);
    return;
  }

  if (toolCallState.status !== "generated") {
    return;
  }

  // Track tool call acceptance and start timing
  const startTime = Date.now();

  const selectedChatModel = selectSelectedChatModel(state);

  posthog.capture("tool_call_decision", {
    model: selectedChatModel,
    decision: isAutoApproved ? "auto_accept" : "accept",
    toolName: toolCallState.toolCall.function.name,
    toolCallId: toolCallId,
  });

  if (!selectedChatModel) {
    throw new Error("No model selected");
  }

  dispatch(
    setToolCallCalling({
      toolCallId,
    }),
  );

  // S-1a: Execution boundary interception — block first non-todo tool if no plan exists.
  // todoListItems is undefined when manage_todo_list has never been called in this session.
  const toolName = toolCallState.toolCall.function.name;
  if (
    toolName !== BuiltInToolNames.ManageTodoList &&
    state.session.todoListItems === undefined
  ) {
    dispatch(
      updateToolCallOutput({
        toolCallId,
        contextItems: [
          {
            icon: "problems",
            name: "No Task Plan Found",
            description: "Tool Execution Blocked",
            content:
              "**Tool execution blocked — no task plan exists.**\n\n" +
              "Before calling any tool, you must first call `manage_todo_list` to create " +
              "a structured plan with 3–7 steps. This ensures your work is organized, " +
              "trackable, and can be reviewed.\n\n" +
              "Please call `manage_todo_list` now to define your plan, " +
              "then proceed with the original task.",
            hidden: false,
          },
        ],
      }),
    );
    dispatch(errorToolCall({ toolCallId }));
    const wrapped = await dispatch(
      streamResponseAfterToolCall({ toolCallId, depth: depth + 1 }),
    );
    unwrapResult(wrapped);
    return;
  }

  let output: ContextItem[] | undefined = undefined;
  let mcpUiState: McpUiState | undefined = undefined;
  let error: ContinueError | undefined = undefined;
  let streamResponse: boolean;

  // IMPORTANT:
  // Errors that occur while calling tool call implementations
  // Are caught and passed in output as context items
  // Errors that occur outside specifically calling the tool
  // Should not be caught here - should be handled as normal stream errors
  if (
    CLIENT_TOOLS_IMPLS.find(
      (toolName) => toolName === toolCallState.toolCall.function.name,
    )
  ) {
    // Tool is called on client side
    const {
      output: clientToolOutput,
      respondImmediately,
      error: clientToolError,
    } = await callClientTool(toolCallState, {
      dispatch,
      ideMessenger: extra.ideMessenger,
      getState,
    });
    output = clientToolOutput;
    error = clientToolError;
    streamResponse = respondImmediately;
  } else {
    // Tool is called on core side — with S-5 transient-error retry
    let retryCount = 0;
    while (true) {
      const result = await extra.ideMessenger.request("tools/call", {
        toolCall: toolCallState.toolCall,
      });

      if (result.status === "error") {
        // IPC-level error: check if transient before throwing
        if (retryCount < MAX_TOOL_RETRIES && isTransientMessage(result.error)) {
          retryCount++;
          await sleep(getRetryDelay(retryCount - 1));
          continue;
        }
        throw new Error(result.error);
      }

      // Tool returned a structured error — classify before deciding to retry
      if (result.content.errorMessage) {
        const errObj = new ContinueError(
          (result.content.errorReason as ContinueErrorReason | undefined) ??
            ContinueErrorReason.Unknown,
          result.content.errorMessage,
        );
        const failureClass = classifyToolError(errObj);

        if (
          retryCount < MAX_TOOL_RETRIES &&
          failureClass === ToolFailureClass.Transient
        ) {
          retryCount++;
          await sleep(getRetryDelay(retryCount - 1));
          continue;
        }
      }

      // Success or permanent/permission error — exit retry loop
      output = result.content.contextItems;
      mcpUiState = result.content.mcpUiState;
      error = result.content.errorMessage
        ? new ContinueError(
            result.content.errorReason || ContinueErrorReason.Unspecified,
            result.content.errorMessage,
          )
        : undefined;
      break;
    }
    streamResponse = true;
  }

  if (error) {
    const attemptNumber = trackToolError(toolName, error.message);
    const enhancedMessage = formatEnhancedToolError(
      toolName,
      error.message,
      attemptNumber,
    );

    // A-7: Add failure class annotation so the model can triage better
    const failureClass = classifyToolError(error);
    const classLabel =
      failureClass === ToolFailureClass.PermissionFail
        ? "Permission/security error — do not retry; inform the user."
        : failureClass === ToolFailureClass.Transient
          ? "Transient error — system already retried; try a different approach."
          : ""; // Permanent: existing message is sufficient

    dispatch(
      updateToolCallOutput({
        toolCallId,
        contextItems: [
          {
            icon: "problems",
            name: "Tool Call Error",
            description: "Tool Call Failed",
            content: classLabel
              ? `${enhancedMessage}\n\n[${classLabel}]`
              : enhancedMessage,
            hidden: false,
          },
        ],
      }),
    );
  } else if (output?.length) {
    // Clear error tracking on success
    clearToolErrors(toolName);

    // S-4: Auto-verification gate — inject get_problems result after edit tools
    let verifiedOutput: ContextItem[] = output;
    if (EDIT_TOOL_NAMES.has(toolName)) {
      try {
        const verifyResult = await extra.ideMessenger.request("tools/call", {
          toolCall: {
            id: `auto_verify_${toolCallId}`,
            type: "function",
            function: {
              name: BuiltInToolNames.GetProblems,
              arguments: "{}",
            },
          },
        });
        if (
          verifyResult.status === "success" &&
          verifyResult.content.contextItems?.length
        ) {
          const verifyItems: ContextItem[] =
            verifyResult.content.contextItems.map((item: ContextItem) => ({
              ...item,
              name: `[Auto-Verification] ${item.name}`,
              description: `Post-edit verification: ${item.description}`,
            }));
          verifiedOutput = [...output, ...verifyItems];
        }
      } catch {
        // Non-fatal — verification is best-effort; proceed without it
      }
    }

    dispatch(
      updateToolCallOutput({
        toolCallId,
        contextItems: verifiedOutput,
        mcpUiState,
      }),
    );
  }

  // Capture telemetry for tool call execution outcome with duration
  const duration_ms = Date.now() - startTime;
  posthog.capture("tool_call_outcome", {
    model: selectedChatModel,
    succeeded: !error,
    toolName: toolName,
    errorReason: error?.reason,
    duration_ms: duration_ms,
  });

  if (streamResponse) {
    if (error) {
      logToolUsage(toolCallState, false, false, extra.ideMessenger, output);
      dispatch(
        errorToolCall({
          toolCallId,
        }),
      );

      // Stop agent loop if consecutive same-error limit reached
      if (hasReachedErrorLimit(toolName, error.message)) {
        dispatch(setInactive());
        return;
      }
    } else {
      logToolUsage(toolCallState, true, true, extra.ideMessenger, output);
      dispatch(
        acceptToolCall({
          toolCallId,
        }),
      );
    }

    // Send to the LLM to continue the conversation
    const wrapped = await dispatch(
      streamResponseAfterToolCall({
        toolCallId,
        depth: depth + 1,
      }),
    );
    unwrapResult(wrapped);
  } else {
    dispatch(setInactive());
  }
});
