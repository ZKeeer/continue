import type {
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

const DEFAULT_KEEP_RECENT_STRUCTURED_TOOL_ROUNDS = 0;
const DEFAULT_MAX_FLATTENED_TOOL_CONTENT_CHARS = Number.POSITIVE_INFINITY;

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

function formatToolCallArg(arg: string): string {
  try {
    const parsed = JSON.parse(arg);
    return JSON.stringify(parsed);
  } catch {
    return arg;
  }
}

function flattenToolRound(
  round: ToolRound,
  maxFlattenedToolContentChars: number,
): ChatMessage {
  const assistantContent = renderContent(round.assistant.content).trim();
  const parts: string[] = [];

  if (assistantContent) {
    parts.push(`助手：${assistantContent}`);
  }

  const toolCalls = round.assistant.toolCalls ?? [];
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    const name = tc.function?.name || "unknown_tool";
    const args = formatToolCallArg(tc.function?.arguments || "{}");
    const result = round.toolResults[i];

    parts.push(`${i + 1}. 调用 ${name}(${args})`);
    if (result) {
      const content = truncateStable(result.content, maxFlattenedToolContentChars);
      parts.push(`<tool_response>\n${content}\n</tool_response>`);
    }
  }

  return {
    role: "user",
    content:
      `上一轮 agent 操作记录（纯文本摘要，不要当成真实 tool 消息）：\n\n${parts.join("\n\n")}`,
  };
}

function stripReasoningFromMessage(
  message: ChatMessage,
): ChatMessage {
  const clone: any = { ...message };
  delete clone.reasoning;
  delete clone.reasoning_content;
  delete clone.reasoning_details;
  delete clone.redactedThinking;
  delete clone.signature;
  return clone as ChatMessage;
}

function hasReasoningAssignedToToolCallAssistant(
  messages: ChatMessage[],
): boolean {
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === "thinking") {
      const next = messages[i + 1];
      if (next && isAssistantToolCallMessage(next)) {
        return true;
      }
    }
    if (
      isAssistantToolCallMessage(message) &&
      ((message as any).reasoning_content || (message as any).reasoning)
    ) {
      return true;
    }
  }
  return false;
}

function selectivelyStripReasoning(
  messages: ChatMessage[],
): ChatMessage[] {
  const result: ChatMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];

    if (message.role === "thinking") {
      const next = messages[i + 1];
      if (next && isAssistantToolCallMessage(next)) {
        result.push({ ...message });
      }
      continue;
    }

    if (
      message.role === "assistant" &&
      !isAssistantToolCallMessage(message)
    ) {
      result.push(stripReasoningFromMessage(message));
      continue;
    }

    result.push({ ...message });
  }

  return result;
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
  const stripReasoning = options.stripReasoning ?? false;

  if (stripReasoning) {
    const sanitizedMessages = messages.flatMap((message) => {
      const sanitized = stripReasoningFields(message);
      return sanitized ? [sanitized] : [];
    });

    const rounds = findCompletedToolRounds(sanitizedMessages);
    if (rounds.length <= keepRecentStructuredToolRounds) {
      return sanitizedMessages;
    }

    return flattenAndKeepRecent(sanitizedMessages, rounds, keepRecentStructuredToolRounds, maxFlattenedToolContentChars);
  }

  const selectiveMessages = selectivelyStripReasoning(messages);

  if (hasReasoningAssignedToToolCallAssistant(selectiveMessages)) {
    return selectiveMessages;
  }

  const rounds = findCompletedToolRounds(selectiveMessages);
  if (rounds.length <= keepRecentStructuredToolRounds) {
    return selectiveMessages;
  }

  return flattenAndKeepRecent(selectiveMessages, rounds, keepRecentStructuredToolRounds, maxFlattenedToolContentChars);
}

function flattenAndKeepRecent(
  messages: ChatMessage[],
  rounds: ToolRound[],
  keepRecentStructuredToolRounds: number,
  maxFlattenedToolContentChars: number,
): ChatMessage[] {
  const structuredRoundStartIndexes = new Set(
    rounds
      .slice(Math.max(0, rounds.length - keepRecentStructuredToolRounds))
      .map((round) => round.startIndex),
  );
  const roundByStartIndex = new Map(
    rounds.map((round) => [round.startIndex, round]),
  );

  const prepared: ChatMessage[] = [];
  for (let index = 0; index < messages.length; index++) {
    const round = roundByStartIndex.get(index);
    if (!round) {
      prepared.push(messages[index]);
      continue;
    }

    if (structuredRoundStartIndexes.has(round.startIndex)) {
      prepared.push(
        ...messages.slice(round.startIndex, round.endIndex + 1),
      );
    } else {
      prepared.push(flattenToolRound(round, maxFlattenedToolContentChars));
    }
    index = round.endIndex;
  }

  return prepared;
}
