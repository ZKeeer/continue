import {
  AssistantChatMessage,
  ChatMessage,
  MessageContent,
  ToolCallDelta,
  ToolResultChatMessage,
} from "../index.js";
import { stripImages } from "../util/messageContent.js";

export interface OpenAIHistoryPreprocessorOptions {
  keepRecentStructuredToolRounds?: number;
  maxFlattenedToolContentChars?: number;
  stripReasoning?: boolean;
}

interface ToolRound {
  roundNumber: number;
  startIndex: number;
  endIndex: number;
  assistant: AssistantChatMessage;
  toolResults: ToolResultChatMessage[];
}

const DEFAULT_KEEP_RECENT_STRUCTURED_TOOL_ROUNDS = 2;
const DEFAULT_MAX_FLATTENED_TOOL_CONTENT_CHARS = 2000;

function stripReasoningFields(message: ChatMessage): ChatMessage | undefined {
  if (message.role === "thinking") {
    return undefined;
  }

  const clone: any = { ...message };
  delete clone.reasoning;
  delete clone.reasoning_content;
  delete clone.reasoning_details;
  delete clone.redactedThinking;
  delete clone.signature;

  return clone as ChatMessage;
}

function renderContent(content: MessageContent): string {
  if (typeof content === "string") {
    return content;
  }

  return stripImages(content);
}

function truncateStable(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }

  return `${content.slice(0, maxChars)}\n...[truncated ${content.length - maxChars} chars]`;
}

function isAssistantToolCallMessage(
  message: ChatMessage,
): message is AssistantChatMessage {
  return (
    message.role === "assistant" &&
    Array.isArray(message.toolCalls) &&
    message.toolCalls.length > 0
  );
}

function isToolMessage(message: ChatMessage): message is ToolResultChatMessage {
  return message.role === "tool";
}

function toolCallIds(toolCalls: ToolCallDelta[]): Set<string> {
  return new Set(
    toolCalls
      .map((toolCall) => toolCall.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
}

function findCompletedToolRounds(messages: ChatMessage[]): ToolRound[] {
  const rounds: ToolRound[] = [];

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!isAssistantToolCallMessage(message)) {
      continue;
    }

    const ids = toolCallIds(message.toolCalls ?? []);
    if (ids.size === 0) {
      continue;
    }

    const toolResults: ToolResultChatMessage[] = [];
    let cursor = index + 1;
    while (cursor < messages.length) {
      const toolMessage = messages[cursor];
      if (!isToolMessage(toolMessage) || !ids.has(toolMessage.toolCallId)) {
        break;
      }

      toolResults.push(toolMessage);
      cursor++;
    }

    if (toolResults.length === 0) {
      continue;
    }

    rounds.push({
      roundNumber: rounds.length + 1,
      startIndex: index,
      endIndex: cursor - 1,
      assistant: message,
      toolResults,
    });
    index = cursor - 1;
  }

  return rounds;
}

function renderToolCall(toolCall: ToolCallDelta, index: number): string {
  const name = toolCall.function?.name || "unknown_tool";
  const args = toolCall.function?.arguments || "{}";
  const id = toolCall.id ? ` id=${toolCall.id}` : "";
  return `${index + 1}. ${name}${id}\nArguments: ${args}`;
}

function flattenToolRound(
  round: ToolRound,
  maxFlattenedToolContentChars: number,
): ChatMessage {
  const assistantContent = renderContent(round.assistant.content).trim();
  const toolCalls = (round.assistant.toolCalls ?? [])
    .map(renderToolCall)
    .join("\n");
  const toolResults = round.toolResults
    .map((toolResult, index) => {
      const content = truncateStable(
        toolResult.content,
        maxFlattenedToolContentChars,
      );
      return `${index + 1}. tool_call_id=${toolResult.toolCallId}\nResult:\n${content}`;
    })
    .join("\n");

  return {
    role: "user",
    content: [
      `<previous_tool_round index="${round.roundNumber}">`,
      `Previous tool round ${round.roundNumber} was flattened from structured tool-call history for model reasoning and prefix-cache stability.`,
      "Assistant visible content:",
      assistantContent || "(empty)",
      "Tool calls:",
      toolCalls || "(none)",
      "Tool results:",
      toolResults || "(none)",
      "</previous_tool_round>",
    ].join("\n"),
  };
}

export function prepareOpenAICompatibleMessagesForReasoning(
  messages: ChatMessage[],
  options: OpenAIHistoryPreprocessorOptions = {},
): ChatMessage[] {
  const keepRecentStructuredToolRounds =
    options.keepRecentStructuredToolRounds ??
    DEFAULT_KEEP_RECENT_STRUCTURED_TOOL_ROUNDS;
  const maxFlattenedToolContentChars =
    options.maxFlattenedToolContentChars ??
    DEFAULT_MAX_FLATTENED_TOOL_CONTENT_CHARS;
  const stripReasoning = options.stripReasoning ?? true;

  const sanitizedMessages = stripReasoning
    ? messages.flatMap((message) => {
        const sanitized = stripReasoningFields(message);
        return sanitized ? [sanitized] : [];
      })
    : messages.map((message) => ({ ...message }));

  const rounds = findCompletedToolRounds(sanitizedMessages);
  if (rounds.length <= keepRecentStructuredToolRounds) {
    return sanitizedMessages;
  }

  const structuredRoundStartIndexes = new Set(
    rounds
      .slice(Math.max(0, rounds.length - keepRecentStructuredToolRounds))
      .map((round) => round.startIndex),
  );
  const roundByStartIndex = new Map(
    rounds.map((round) => [round.startIndex, round]),
  );

  const prepared: ChatMessage[] = [];
  for (let index = 0; index < sanitizedMessages.length; index++) {
    const round = roundByStartIndex.get(index);
    if (!round) {
      prepared.push(sanitizedMessages[index]);
      continue;
    }

    if (structuredRoundStartIndexes.has(round.startIndex)) {
      prepared.push(
        ...sanitizedMessages.slice(round.startIndex, round.endIndex + 1),
      );
    } else {
      prepared.push(flattenToolRound(round, maxFlattenedToolContentChars));
    }
    index = round.endIndex;
  }

  return prepared;
}
