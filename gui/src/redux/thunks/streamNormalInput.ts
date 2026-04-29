import { createAsyncThunk, unwrapResult } from "@reduxjs/toolkit";
import { LLMFullCompletionOptions, ModelDescription } from "core";
import { getRuleId } from "core/llm/rules/getSystemMessageWithRules";
import { ToCoreProtocol } from "core/protocol";
import { BUILT_IN_GROUP_NAME } from "core/tools/builtIn";
import { selectActiveTools } from "../selectors/selectActiveTools";
import { selectSelectedChatModel } from "../slices/configSlice";
import {
  abortStream,
  addPromptCompletionPair,
  errorToolCall,
  setActive,
  setAgentRunStartTime,
  setAppliedRulesAtIndex,
  setContextPercentage,
  setInactive,
  setInlineErrorMessage,
  setIsPruned,
  setToolGenerated,
  streamUpdate,
} from "../slices/sessionSlice";
import { ThunkApiType } from "../store";
import { constructMessages } from "../util/constructMessages";

import { modelSupportsNativeTools } from "core/llm/toolSupport";
import { applyToolOverrides } from "core/tools/applyToolOverrides";
import { addSystemMessageToolsToSystemMessage } from "core/tools/systemMessageTools/buildToolsSystemMessage";
import { interceptSystemToolCalls } from "core/tools/systemMessageTools/interceptSystemToolCalls";
import { SystemMessageToolCodeblocksFramework } from "core/tools/systemMessageTools/toolCodeblocks";
import posthog from "posthog-js";
import {
  selectCurrentToolCalls,
  selectPendingToolCalls,
} from "../selectors/selectToolCalls";
import { getBaseSystemMessage } from "../util/getBaseSystemMessage";
import {
  DEFAULT_AGENT_MAX_BUDGET_DURATION_MS,
  buildAgentBudgetStop,
  getAgentMaxBudgetIterations,
} from "./agentBudget";
import { callToolById } from "./callToolById";
import { evaluateToolPolicies } from "./evaluateToolPolicies";
import { preprocessToolCalls } from "./preprocessToolCallArgs";
import { loadSession } from "./session";
import { streamResponseAfterToolCall } from "./streamResponseAfterToolCall";
import { getModelVisibleTools } from "./subAgentToolRouter";

// Auto-compact threshold: trigger compaction when context usage exceeds this percentage
const AUTO_COMPACT_THRESHOLD = 0.85;

function summarizeToolCallStateForDebug(toolCallState: any) {
  const args = toolCallState?.toolCall?.function?.arguments;
  let parseOk = false;
  if (typeof args === "string") {
    try {
      JSON.parse(args);
      parseOk = true;
    } catch {
      parseOk = false;
    }
  }

  return {
    toolCallId: toolCallState?.toolCallId,
    toolName: toolCallState?.toolCall?.function?.name,
    status: toolCallState?.status,
    providerIndex: toolCallState?.providerIndex,
    argsLength: typeof args === "string" ? args.length : undefined,
    parseOk,
    argsPreview: typeof args === "string" ? args.slice(0, 160) : undefined,
  };
}

function summarizeStreamMessagesForDebug(messages: any[]) {
  return messages
    .filter(
      (message) => message?.role === "assistant" && message?.toolCalls?.length,
    )
    .map((message) => ({
      role: message.role,
      toolCalls: message.toolCalls.map((toolCall: any) => ({
        toolCallId: toolCall.id,
        providerIndex: toolCall.index,
        toolName: toolCall.function?.name,
        argsLength:
          typeof toolCall.function?.arguments === "string"
            ? toolCall.function.arguments.length
            : undefined,
        argsPreview:
          typeof toolCall.function?.arguments === "string"
            ? toolCall.function.arguments.slice(0, 160)
            : undefined,
      })),
    }));
}

/**
 * Builds completion options with reasoning configuration based on session state and model capabilities.
 *
 * @param baseOptions - Base completion options to extend
 * @param hasReasoningEnabled - Whether reasoning is enabled in the session
 * @param model - The selected model with provider and completion options
 * @returns Completion options with reasoning configuration
 */
function buildReasoningCompletionOptions(
  baseOptions: LLMFullCompletionOptions,
  hasReasoningEnabled: boolean | undefined,
  model: ModelDescription,
): LLMFullCompletionOptions {
  if (hasReasoningEnabled === undefined) {
    return baseOptions;
  }

  const reasoningOptions: LLMFullCompletionOptions = {
    ...baseOptions,
    reasoning: !!hasReasoningEnabled,
  };

  // Add reasoning budget tokens if reasoning is enabled and provider supports it
  if (hasReasoningEnabled && model.underlyingProviderName !== "ollama") {
    // Ollama doesn't support limiting reasoning tokens at this point
    reasoningOptions.reasoningBudgetTokens =
      model.completionOptions?.reasoningBudgetTokens ?? 2048;
  }

  return reasoningOptions;
}

export const streamNormalInput = createAsyncThunk<
  void,
  {
    legacySlashCommandData?: ToCoreProtocol["llm/streamChat"][0]["legacySlashCommandData"];
    depth?: number;
  },
  ThunkApiType
>(
  "chat/streamNormalInput",
  async (
    { legacySlashCommandData, depth = 0 },
    { dispatch, extra, getState },
  ): Promise<void> => {
    // S-2a: Budget tracking — record start time on first call; check the single configurable iteration budget on subsequent calls
    if (depth === 0) {
      dispatch(setAgentRunStartTime(Date.now()));
    } else {
      const startTime = getState().session.agentRunStartTime;
      const nowMs = Date.now();
      const maxBudgetIterations = getAgentMaxBudgetIterations(
        getState().ui.agent,
      );
      const elapsedMs = startTime !== undefined ? nowMs - startTime : 0;
      const exceededClock = elapsedMs >= DEFAULT_AGENT_MAX_BUDGET_DURATION_MS;

      if (depth >= maxBudgetIterations || exceededClock) {
        const elapsedLimitMin = Math.round(
          DEFAULT_AGENT_MAX_BUDGET_DURATION_MS / 60_000,
        );
        const budgetStop = buildAgentBudgetStop({
          depth,
          maxBudgetIterations,
          agentRunStartTime: startTime,
          nowMs,
          todoItems: getState().session.todoListItems,
          stopReason: exceededClock
            ? `Wall-clock budget exceeded (${Math.round(elapsedMs / 60_000)}min / ${elapsedLimitMin}min limit)`
            : undefined,
        });

        console.warn(
          `[AgentBudget] Stopping: elapsed=${budgetStop.elapsedMin}min iterations=${depth} maxBudgetIterations=${maxBudgetIterations}`,
        );

        // S-2a: Write a structured stop record into the conversation history
        // so it is visible in the transcript, result cards, and any future replay.
        dispatch(streamUpdate([budgetStop.budgetStopMessage]));

        // Also show a UI banner for immediate visibility
        dispatch(setInlineErrorMessage(budgetStop.inlineErrorMessage));
        dispatch(setInactive());
        return;
      }
    }

    const state = getState();
    const selectedChatModel = selectSelectedChatModel(state);

    if (!selectedChatModel) {
      throw new Error("No chat model selected");
    }

    // Get tools and apply model-level overrides (disabled, description, etc.)
    let activeTools = selectActiveTools(state);
    if (selectedChatModel.toolOverrides?.length) {
      const { tools: overriddenTools, errors } = applyToolOverrides(
        activeTools,
        selectedChatModel.toolOverrides,
      );
      activeTools = overriddenTools;
      for (const error of errors) {
        if (!error.fatal) {
          console.warn(`Tool override warning: ${error.message}`);
        }
      }
    }
    const modelVisibleTools = getModelVisibleTools(activeTools);

    // Use the centralized selector to determine if system message tools should be used
    const useNativeTools = state.config.config.experimental
      ?.onlyUseSystemMessageTools
      ? false
      : modelSupportsNativeTools(selectedChatModel);
    const systemToolsFramework = !useNativeTools
      ? new SystemMessageToolCodeblocksFramework()
      : undefined;

    // Construct completion options
    let completionOptions: LLMFullCompletionOptions = {};
    if (useNativeTools && modelVisibleTools.length > 0) {
      completionOptions = {
        tools: modelVisibleTools,
      };
    }

    completionOptions = buildReasoningCompletionOptions(
      completionOptions,
      state.session.hasReasoningEnabled,
      selectedChatModel,
    );

    // Construct messages (excluding system message)
    const baseSystemMessage = getBaseSystemMessage(
      state.session.mode,
      selectedChatModel,
      modelVisibleTools,
    );

    const systemMessage = systemToolsFramework
      ? addSystemMessageToolsToSystemMessage(
          systemToolsFramework,
          baseSystemMessage,
          modelVisibleTools,
        )
      : baseSystemMessage;

    const withoutMessageIds = state.session.history.map((item) => {
      const { id, ...messageWithoutId } = item.message;
      return { ...item, message: messageWithoutId };
    });

    const { messages, appliedRules, appliedRuleIndex } = constructMessages(
      withoutMessageIds,
      systemMessage,
      state.config.config.rules,
      state.ui.ruleSettings,
      systemToolsFramework,
    );

    // TODO parallel tool calls will cause issues with this
    // because there will be multiple tool messages, so which one should have applied rules?
    dispatch(
      setAppliedRulesAtIndex({
        index: appliedRuleIndex,
        appliedRules: appliedRules,
      }),
    );

    dispatch(setActive());
    dispatch(setInlineErrorMessage(undefined));

    const precompiledRes = await extra.ideMessenger.request("llm/compileChat", {
      messages,
      options: completionOptions,
    });

    if (precompiledRes.status === "error") {
      if (precompiledRes.error.includes("Not enough context")) {
        dispatch(setInlineErrorMessage("out-of-context"));
        dispatch(setInactive());
        return;
      } else {
        throw new Error(precompiledRes.error);
      }
    }

    const { compiledChatMessages, didPrune, contextPercentage } =
      precompiledRes.content;

    // [zkdev] Auto-compact: if context usage exceeds threshold and history has no summary yet
    const history = state.session.history;
    const hasExistingSummary = history.some((item) => item.conversationSummary);
    if (
      contextPercentage > AUTO_COMPACT_THRESHOLD &&
      !hasExistingSummary &&
      history.length > 2 &&
      depth === 0 // Only auto-compact on first attempt to avoid loops
    ) {
      console.log(
        `[AutoCompact] Triggered: contextPercentage=${(contextPercentage * 100).toFixed(1)}% > ${AUTO_COMPACT_THRESHOLD * 100}%`,
      );
      // Notify user that compaction is in progress
      dispatch(setInlineErrorMessage("auto-compacting"));

      // Request compaction for all messages except the last user message
      // Sliding window: preserve recent 3 rounds (6 messages) of conversation
      const preserveCount = Math.min(6, history.length - 2);
      const compactIndex = Math.max(0, history.length - 2 - preserveCount);
      const sessionId = state.session.id;
      if (sessionId && compactIndex > 0) {
        try {
          await extra.ideMessenger.request("conversation/compact", {
            index: compactIndex,
            sessionId,
          });
          // Reload session to get compacted history
          await dispatch(loadSession({ sessionId, saveCurrentSession: false }));
        } catch (e) {
          console.error("[AutoCompact] Failed:", e);
        } finally {
          // Clear compaction notification
          dispatch(setInlineErrorMessage(undefined));
        }
        // Retry with compacted history
        dispatch(setInactive());
        await dispatch(
          streamNormalInput({ legacySlashCommandData, depth: depth + 1 }),
        );
        return;
      } else {
        dispatch(setInlineErrorMessage(undefined));
      }
    }

    dispatch(setIsPruned(didPrune));
    dispatch(setContextPercentage(contextPercentage));

    const start = Date.now();
    const streamAborter = state.session.streamAborter;
    try {
      let gen = extra.ideMessenger.llmStreamChat(
        {
          completionOptions,
          title: selectedChatModel.title,
          messages: compiledChatMessages,
          legacySlashCommandData,
          messageOptions: { precompiled: true },
        },
        streamAborter.signal,
      );
      if (systemToolsFramework && modelVisibleTools.length > 0) {
        gen = interceptSystemToolCalls(
          gen,
          streamAborter,
          systemToolsFramework,
        );
      }

      let iteration = 0;
      let next = await gen.next();
      while (!next.done) {
        iteration++;
        const streamedToolCalls = summarizeStreamMessagesForDebug(next.value);
        if (streamedToolCalls.length > 0) {
          console.log(
            `[StreamNormalInput] streamUpdate ${JSON.stringify({
              iteration,
              streamedToolCalls,
            })}`,
          );
        }
        if (!getState().session.isStreaming) {
          console.log(
            `[StreamNormalInput] aborting due to isStreaming=false ${JSON.stringify(
              {
                iteration,
                aborted: streamAborter.signal.aborted,
                currentToolCalls: selectCurrentToolCalls(getState()).map(
                  summarizeToolCallStateForDebug,
                ),
              },
            )}`,
          );
          dispatch(abortStream());
          break;
        }

        dispatch(streamUpdate(next.value));
        next = await gen.next();
      }

      console.log(
        `[StreamNormalInput] generator exit ${JSON.stringify({
          done: next.done,
          iteration,
          aborted: streamAborter.signal.aborted,
          isStreaming: getState().session.isStreaming,
          returnedPromptLog: !!next.value,
          currentToolCalls: selectCurrentToolCalls(getState()).map(
            summarizeToolCallStateForDebug,
          ),
        })}`,
      );

      // Attach prompt log and end thinking for reasoning models
      if (next.done && next.value) {
        dispatch(addPromptCompletionPair([next.value]));

        try {
          extra.ideMessenger.post("devdata/log", {
            name: "chatInteraction",
            data: {
              prompt: next.value.prompt,
              completion: next.value.completion,
              modelProvider: selectedChatModel.underlyingProviderName,
              modelName: selectedChatModel.title,
              modelTitle: selectedChatModel.title,
              sessionId: state.session.id,
              ...(!!modelVisibleTools.length && {
                tools: modelVisibleTools.map((tool) => tool.function.name),
              }),
              ...(appliedRules.length > 0 && {
                rules: appliedRules.map((rule) => ({
                  id: getRuleId(rule),
                  slug: rule.slug,
                })),
              }),
            },
          });
        } catch (e) {
          console.error("Failed to send dev data interaction log", e);
        }
      }
    } catch (e) {
      console.log(
        `[StreamNormalInput] generator threw ${JSON.stringify({
          aborted: streamAborter.signal.aborted,
          isStreaming: getState().session.isStreaming,
          errorMessage: e instanceof Error ? e.message : String(e),
          currentToolCalls: selectCurrentToolCalls(getState()).map(
            summarizeToolCallStateForDebug,
          ),
        })}`,
      );
      const toolCallsToCancel = selectCurrentToolCalls(getState());
      posthog.capture("stream_premature_close_error", {
        duration: (Date.now() - start) / 1000,
        model: selectedChatModel.model,
        provider: selectedChatModel.underlyingProviderName,
        context: legacySlashCommandData ? "slash_command" : "regular_chat",
        ...(legacySlashCommandData && {
          command: legacySlashCommandData.command.name,
        }),
      });
      if (
        toolCallsToCancel.length > 0 &&
        e instanceof Error &&
        e.message.toLowerCase().includes("premature close")
      ) {
        for (const tc of toolCallsToCancel) {
          dispatch(
            errorToolCall({
              toolCallId: tc.toolCallId,
              output: [
                {
                  name: "Tool Call Error",
                  description: "Premature Close",
                  content: `"Premature Close" error: this tool call was aborted mid-stream because the arguments took too long to stream or there were network issues. Please re-attempt by breaking the operation into smaller chunks or trying something else`,
                  icon: "problems",
                },
              ],
            }),
          );
        }
      } else {
        throw e;
      }
    }

    // Tool call sequence:
    // 1. Mark generating tool calls as generated
    const state1 = getState();
    if (streamAborter.signal.aborted || !state1.session.isStreaming) {
      console.log(
        `[StreamNormalInput] skipping setToolGenerated ${JSON.stringify({
          aborted: streamAborter.signal.aborted,
          isStreaming: state1.session.isStreaming,
          currentToolCalls: selectCurrentToolCalls(state1).map(
            summarizeToolCallStateForDebug,
          ),
        })}`,
      );
      return;
    }
    const originalToolCalls = selectCurrentToolCalls(state1);
    const generatingCalls = originalToolCalls.filter(
      (tc) => tc.status === "generating",
    );
    if (generatingCalls.length > 0) {
      console.log(
        `[StreamNormalInput] promoting generating tool calls ${JSON.stringify({
          generatingCalls: generatingCalls.map(summarizeToolCallStateForDebug),
        })}`,
      );
    }
    for (const { toolCallId } of generatingCalls) {
      dispatch(
        setToolGenerated({
          toolCallId,
          tools: state1.config.config.tools,
        }),
      );
    }

    // 2. Pre-process args to catch invalid args before checking policies
    const state2 = getState();
    if (streamAborter.signal.aborted || !state2.session.isStreaming) {
      return;
    }
    const generatedCalls2 = selectPendingToolCalls(state2);
    await preprocessToolCalls(dispatch, extra.ideMessenger, generatedCalls2);

    // 3. Security check: evaluate updated policies based on args
    const state3 = getState();
    if (streamAborter.signal.aborted || !state3.session.isStreaming) {
      return;
    }
    const generatedCalls3 = selectPendingToolCalls(state3);
    const toolPolicies = state3.ui.toolSettings;
    const policies = await evaluateToolPolicies(
      dispatch,
      extra.ideMessenger,
      activeTools,
      generatedCalls3,
      toolPolicies,
    );
    const autoApprovedPolicies = policies.filter(
      ({ policy }) => policy === "allowedWithoutPermission",
    );
    const needsApprovalPolicies = policies.filter(
      ({ policy }) => policy === "allowedWithPermission",
    );

    // 4. Execute remaining tool calls
    if (originalToolCalls.length === 0) {
      dispatch(setInactive());
    } else if (needsApprovalPolicies.length > 0) {
      const builtInReadonlyAutoApproved = autoApprovedPolicies.filter(
        ({ toolCallState }) =>
          toolCallState.tool?.group === BUILT_IN_GROUP_NAME &&
          toolCallState.tool?.readonly,
      );

      if (builtInReadonlyAutoApproved.length > 0) {
        const state4 = getState();
        if (streamAborter.signal.aborted || !state4.session.isStreaming) {
          return;
        }
        await Promise.all(
          builtInReadonlyAutoApproved.map(async ({ toolCallState }) => {
            unwrapResult(
              await dispatch(
                callToolById({
                  toolCallId: toolCallState.toolCallId,
                  isAutoApproved: true,
                  depth: depth + 1,
                  availableTools: activeTools,
                }),
              ),
            );
          }),
        );
      }

      dispatch(setInactive());
    } else {
      // auto stream cases increase thunk depth by 1 for debugging
      const state4 = getState();
      const generatedCalls4 = selectPendingToolCalls(state4);
      if (streamAborter.signal.aborted || !state4.session.isStreaming) {
        return;
      }
      if (generatedCalls4.length > 0) {
        const deferContinuation = generatedCalls4.length > 1;
        await Promise.all(
          generatedCalls4.map(async ({ toolCallId }) => {
            unwrapResult(
              await dispatch(
                callToolById({
                  toolCallId,
                  isAutoApproved: true,
                  depth: depth + 1,
                  deferContinuation,
                  availableTools: activeTools,
                }),
              ),
            );
          }),
        );
        if (deferContinuation) {
          unwrapResult(
            await dispatch(
              streamResponseAfterToolCall({
                toolCallId:
                  generatedCalls4[generatedCalls4.length - 1].toolCallId,
                depth: depth + 1,
              }),
            ),
          );
        }
      } else {
        for (const { toolCallId } of originalToolCalls) {
          unwrapResult(
            await dispatch(
              streamResponseAfterToolCall({
                toolCallId,
                depth: depth + 1,
              }),
            ),
          );
        }
      }
    }
  },
);
