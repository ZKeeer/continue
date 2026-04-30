import { ChatHistoryItem, ILLM } from "..";
import { compactConversation } from "./conversationCompaction";

function toolMessage(id: string, content: string): ChatHistoryItem {
  return {
    message: {
      role: "tool",
      toolCallId: id,
      content,
    },
    contextItems: [],
  };
}

describe("compactConversation", () => {
  it("keeps recent tool results untruncated while truncating older tool results", async () => {
    const oldToolContent = `old ${"a".repeat(2500)} end-old`;
    const recentToolContent1 = `recent1 ${"b".repeat(2500)} end-recent1`;
    const recentToolContent2 = `recent2 ${"c".repeat(2500)} end-recent2`;
    const history: ChatHistoryItem[] = [
      { message: { role: "user", content: "start" }, contextItems: [] },
      toolMessage("old", oldToolContent),
      toolMessage("recent1", recentToolContent1),
      toolMessage("recent2", recentToolContent2),
    ];
    const savedSessions: any[] = [];
    const historyManager = {
      load: () => ({ id: "session", history }),
      save: (session: any) => savedSessions.push(session),
    } as any;
    const chatCalls: ChatHistoryItem["message"][][] = [];
    const currentModel = {
      chat: async (messages: ChatHistoryItem["message"][]) => {
        chatCalls.push(messages);
        return { content: "summary" };
      },
    } as unknown as ILLM;

    await compactConversation({
      sessionId: "session",
      index: history.length - 1,
      historyManager,
      currentModel,
    });

    const compactMessages = chatCalls[0];
    expect(compactMessages[1].content).toContain("[truncated");
    expect(compactMessages[1].content).not.toContain("end-old");
    expect(compactMessages[2].content).toBe(recentToolContent1);
    expect(compactMessages[3].content).toBe(recentToolContent2);
    expect(
      savedSessions[0].history[history.length - 1].conversationSummary,
    ).toBe("summary");
  });
});
