import { ChatHistoryItem, ILLM, ToolResultChatMessage } from "..";
import { HistoryManager } from "./history";
import { stripImages } from "./messageContent";

export interface CompactionParams {
  sessionId: string;
  index: number;
  historyManager: HistoryManager;
  currentModel: ILLM;
}

// Maximum characters for a single tool result message content in compaction input.
// Large file reads / terminal outputs are truncated to save tokens for the summary model.
const MAX_TOOL_CONTENT_CHARS_FOR_COMPACTION = 2000;
const RECENT_TOOL_RESULTS_TO_KEEP_UNTRUNCATED_FOR_COMPACTION = 4;

/**
 * Truncate tool result content for compaction to avoid wasting summary model tokens
 * on large file contents or verbose terminal outputs.
 */
function truncateForCompaction(content: string): string {
  if (content.length <= MAX_TOOL_CONTENT_CHARS_FOR_COMPACTION) {
    return content;
  }
  return (
    content.substring(0, MAX_TOOL_CONTENT_CHARS_FOR_COMPACTION) +
    `\n...[truncated, ${content.length - MAX_TOOL_CONTENT_CHARS_FOR_COMPACTION} chars omitted]`
  );
}

/**
 * Compacts conversation history up to a specified index by generating a summary.
 * This helper function extracts the compaction logic from the main core handler.
 *
 * Optimizations applied before sending to summary model:
 * - Thinking messages are skipped (internal model reasoning, not useful for summary)
 * - Tool result content is truncated to prevent large file reads from dominating the summary
 *
 * @param params - Object containing sessionId, index, historyManager, and currentModel
 * @returns Promise<void> - Updates the session with the conversation summary
 */
export async function compactConversation({
  sessionId,
  index,
  historyManager,
  currentModel,
}: CompactionParams): Promise<void> {
  // Get the current session
  const session = historyManager.load(sessionId);
  const historyUpToIndex = session.history.slice(0, index + 1);

  // Apply the same filtering logic as in constructMessages, but exclude the target message
  // if it already has a summary (we're re-compacting)
  let summaryContent = "";
  let filteredHistory = historyUpToIndex;

  // First, check if the target message already has a summary and ignore it
  const targetMessageHasSummary = historyUpToIndex[index].conversationSummary;
  const searchHistory = targetMessageHasSummary
    ? historyUpToIndex.slice(0, index)
    : historyUpToIndex;

  // Find the most recent conversation summary (excluding target if it has one)
  for (let i = searchHistory.length - 1; i >= 0; i--) {
    const summary = searchHistory[i].conversationSummary;
    if (summary) {
      summaryContent = summary;
      // Only include messages that come AFTER the message with the summary
      filteredHistory = historyUpToIndex.slice(i + 1);
      break;
    }
  }

  const messages: ChatHistoryItem["message"][] = [];
  const toolResultIndexesToKeep = new Set<number>();
  for (
    let i = filteredHistory.length - 1;
    i >= 0 &&
    toolResultIndexesToKeep.size <
      RECENT_TOOL_RESULTS_TO_KEEP_UNTRUNCATED_FOR_COMPACTION;
    i--
  ) {
    const item = filteredHistory[i];
    if (
      item.message.role === "tool" &&
      typeof item.message.content === "string"
    ) {
      toolResultIndexesToKeep.add(i);
    }
  }

  // Build messages for compaction, with optimizations:
  // 1. Skip thinking messages (internal model reasoning, no value for summary)
  // 2. Truncate older tool result content while keeping recent tool results intact
  filteredHistory.forEach((item, index) => {
    // Skip thinking messages - they are internal model reasoning
    if (item.message.role === "thinking") {
      return;
    }

    // Truncate tool result content to save tokens
    if (
      item.message.role === "tool" &&
      typeof item.message.content === "string"
    ) {
      messages.push({
        ...item.message,
        content: toolResultIndexesToKeep.has(index)
          ? item.message.content
          : truncateForCompaction(item.message.content),
      });
    } else {
      messages.push(item.message);
    }

    // toolcalls only exist in an assistant message
    if (item.message.role === "assistant" && item.message.toolCalls) {
      // for every toolcall, if there is no tool message with a tool call id already, add a chat message saying that it is empty
      item.message.toolCalls.forEach((toolCall) => {
        if (
          !filteredHistory.find(
            (item) =>
              item.message.role === "tool" &&
              item.message.toolCallId === toolCall.id,
          )
        ) {
          messages.push({
            role: "tool",
            content: "Tool cancelled",
            toolCallId: toolCall.id,
          } as ToolResultChatMessage);
        }
      });
    }
  });

  // If there's a previous summary, include it as a user message at the beginning
  if (summaryContent) {
    messages.unshift({
      role: "user",
      content: `Previous conversation summary:\n\n${summaryContent}`,
    });
  }

  const compactionPrompt = {
    role: "user" as const,
    content:
      "Create a comprehensive summary of this conversation that captures all essential information needed to continue the work seamlessly. Structure your response to preserve technical accuracy and context continuity.\n\nYour summary should include:\n\n1. **Conversation Overview**: Describe the main topic and progression of the discussion, including any shifts in focus or direction.\n\n2. **Active Development**: Detail what was being implemented, modified, or debugged most recently. Include specific technical approaches and methodologies used.\n\n3. **Technical Stack**: List all relevant technologies, frameworks, libraries, coding patterns, and architectural decisions discussed.\n\n4. **File Operations**: Document all files that were created, modified, or referenced, including their purposes and key changes. Include important code snippets and their locations.\n\n5. **Solutions & Troubleshooting**: Summarize problems encountered and how they were resolved, including any debugging steps or workarounds applied.\n\n6. **Outstanding Work**: Clearly identify any incomplete tasks, pending implementations, or next steps that were discussed. Include direct references to user requests and current progress.\n\nIf there's a previous summary in the conversation, integrate its relevant information while removing outdated details. Focus on technical precision and include specific identifiers (file paths, function names, class names, etc.) that would be essential for continuation. Write in third person and maintain an objective, technical tone.",
  };

  // Generate the summary using the current model
  const response = await currentModel.chat(
    [...messages, compactionPrompt],
    new AbortController().signal,
    { maxTokens: 2048 },
  );

  // Update the target message with the conversation summary
  const updatedHistory = [...session.history];
  updatedHistory[index] = {
    ...updatedHistory[index],
    conversationSummary: stripImages(response.content),
  };

  // Update the session with the new history
  const updatedSession = {
    ...session,
    history: updatedHistory,
  };

  historyManager.save(updatedSession);
}
