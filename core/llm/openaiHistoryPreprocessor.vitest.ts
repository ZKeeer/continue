import { describe, expect, it } from "vitest";

import { ChatMessage } from "..";
import { prepareOpenAICompatibleMessagesForReasoning } from "./openaiHistoryPreprocessor";

function toolRound(index: number): ChatMessage[] {
  return [
    {
      role: "assistant",
      content: " ",
      toolCalls: [
        {
          id: `call_${index}`,
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ filepath: `file_${index}.ts` }),
          },
        },
      ],
    },
    {
      role: "tool",
      toolCallId: `call_${index}`,
      content: `file_${index}.ts contents`,
    },
  ];
}

function toolRoundWithThinking(index: number): ChatMessage[] {
  return [
    {
      role: "thinking",
      content: `reasoning for round ${index}`,
    },
    {
      role: "assistant",
      content: " ",
      toolCalls: [
        {
          id: `call_${index}`,
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ filepath: `file_${index}.ts` }),
          },
        },
      ],
    },
    {
      role: "tool",
      toolCallId: `call_${index}`,
      content: `file_${index}.ts contents`,
    },
  ];
}

function multiToolRound(index: number, toolCount: number): ChatMessage[] {
  const toolCalls = Array.from({ length: toolCount }, (_, toolIndex) => ({
    id: `call_${index}_${toolIndex + 1}`,
    type: "function" as const,
    function: {
      name: "read_file",
      arguments: JSON.stringify({
        filepath: `file_${index}_${toolIndex + 1}.ts`,
      }),
    },
  }));

  return [
    {
      role: "assistant",
      content: " ",
      toolCalls,
    },
    ...toolCalls.map((toolCall) => ({
      role: "tool" as const,
      toolCallId: toolCall.id,
      content: `${toolCall.id} contents`,
    })),
  ];
}

describe("prepareOpenAICompatibleMessagesForReasoning", () => {
  it("keeps thinking before tool-call assistant but strips thinking before non-tool-call assistant", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "implement feature" },
      ...toolRoundWithThinking(1),
      {
        role: "thinking",
        content: "final answer reasoning",
      },
      {
        role: "assistant",
        content: "here is the result",
        // no tool_calls
      },
    ];

    const prepared = prepareOpenAICompatibleMessagesForReasoning(messages);

    expect(prepared.map((message) => message.role)).toEqual([
      "system",
      "user",
      "thinking",
      "assistant",
      "tool",
      "assistant",
    ]);
    // thinking before tool-call assistant is kept
    expect(prepared[2].role).toBe("thinking");
    expect(prepared[2].content).toBe("reasoning for round 1");
    // non-tool-call assistant has no reasoning
    expect((prepared[5] as any).reasoning_content).toBeUndefined();
    expect((prepared[5] as any).reasoning).toBeUndefined();
  });

  it("keeps reasoning_content on tool-call assistant messages (Strategy A)", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "implement feature" },
      {
        role: "assistant",
        content: " ",
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ filepath: "file_1.ts" }),
            },
          },
        ],
        reasoning_content: "need to read file first",
      } as ChatMessage,
      {
        role: "tool",
        toolCallId: "call_1",
        content: "file contents",
      },
    ];

    const prepared = prepareOpenAICompatibleMessagesForReasoning(messages);

    expect(prepared.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
    ]);
    expect((prepared[2] as any).reasoning_content).toBe(
      "need to read file first",
    );
  });

  it("strips reasoning fields from non-tool-call assistant messages", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: "hi there",
        reasoning_content: "user said hello",
        reasoning_details: [{ signature: "sig" }],
      } as ChatMessage,
    ];

    const prepared = prepareOpenAICompatibleMessagesForReasoning(messages);

    expect(prepared.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
    ]);
    expect((prepared[2] as any).reasoning_content).toBeUndefined();
    expect((prepared[2] as any).reasoning_details).toBeUndefined();
  });

  it("flattens tool rounds with hybrid format when no reasoning present (Strategy B)", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "implement feature" },
      ...toolRound(1),
      ...toolRound(2),
      ...toolRound(3),
    ];

    const prepared = prepareOpenAICompatibleMessagesForReasoning(messages);

    expect(prepared.map((message) => message.role)).toEqual([
      "system",
      "user",
      "user",
      "user",
      "user",
    ]);
    expect(prepared[2].content).toContain("上一轮 agent 操作记录");
    expect(prepared[2].content).toContain("调用 read_file");
    expect(prepared[2].content).toContain("<tool_response>");
    expect(prepared[2].content).toContain("file_1.ts contents");
    expect(prepared[2].content).toContain("</tool_response>");
    expect(prepared[3].content).toContain("调用 read_file");
    expect(prepared[3].content).toContain("file_2.ts contents");
    expect(prepared[4].content).toContain("file_3.ts contents");
  });

  it("flattens if tool-call assistants lack reasoning after selective stripping", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "implement feature" },
      ...toolRound(1),
      {
        role: "thinking",
        content: "some thinking for non-tool-call",
      },
      {
        role: "assistant",
        content: "just a text response",
      },
      ...toolRound(2),
    ];

    const prepared = prepareOpenAICompatibleMessagesForReasoning(messages);

    expect(prepared.map((message) => message.role)).toEqual([
      "system",
      "user",
      "user",
      "assistant",
      "user",
    ]);
    expect(prepared[4].content).toContain("上一轮 agent 操作记录");
    expect(prepared[4].content).toContain("file_2.ts contents");
  });

  it("does not truncate tool results unless a limit is provided", () => {
    const longToolContent = `start ${"x".repeat(2500)} end`;
    const messages: ChatMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "inspect file" },
      {
        role: "assistant",
        content: " ",
        toolCalls: [
          {
            id: "call_long",
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ filepath: "large.ts" }),
            },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_long",
        content: longToolContent,
      },
    ];

    const prepared = prepareOpenAICompatibleMessagesForReasoning(messages);

    expect(prepared.map((message) => message.role)).toEqual([
      "system",
      "user",
      "user",
    ]);
    expect(prepared[2].content).toContain(longToolContent);
    expect(prepared[2].content).not.toContain("[truncated");
  });

  it("handles concurrent tool calls in one round", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "implement feature" },
      ...toolRound(1),
      ...multiToolRound(2, 3),
      ...toolRound(3),
    ];

    const prepared = prepareOpenAICompatibleMessagesForReasoning(messages);

    expect(prepared.map((message) => message.role)).toEqual([
      "system",
      "user",
      "user",
      "user",
      "user",
    ]);
    expect(prepared[2].content).toContain("调用 read_file");
    expect(prepared[2].content).toContain("file_1.ts contents");
    expect(prepared[3].content).toContain("1. 调用 read_file");
    expect(prepared[3].content).toContain("call_2_1");
    expect(prepared[3].content).toContain("call_2_2");
    expect(prepared[3].content).toContain("call_2_3");
    expect(prepared[4].content).toContain("file_3.ts contents");
  });

  it("keeps previously flattened rounds stable when a new round is added", () => {
    const baseMessages: ChatMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "implement feature" },
      ...toolRound(1),
      ...toolRound(2),
      ...toolRound(3),
      ...toolRound(4),
    ];
    const extendedMessages: ChatMessage[] = [...baseMessages, ...toolRound(5)];

    const basePrepared =
      prepareOpenAICompatibleMessagesForReasoning(baseMessages);
    const extendedPrepared =
      prepareOpenAICompatibleMessagesForReasoning(extendedMessages);

    expect(extendedPrepared[2]).toEqual(basePrepared[2]);
    expect(extendedPrepared[3]).toEqual(basePrepared[3]);
    expect(extendedPrepared[4].content).toContain("file_3.ts contents");
  });

  it("preserves recent structured tool rounds when keepRecentStructuredToolRounds is set", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "implement feature" },
      ...toolRound(1),
      ...toolRound(2),
      ...toolRound(3),
    ];

    const prepared = prepareOpenAICompatibleMessagesForReasoning(messages, {
      keepRecentStructuredToolRounds: 1,
      maxFlattenedToolContentChars: 10,
    });

    expect(prepared.map((message) => message.role)).toEqual([
      "system",
      "user",
      "user",
      "user",
      "assistant",
      "tool",
    ]);
    expect(prepared[2].content).toContain("...[truncated");
    expect((prepared[4] as any).toolCalls?.[0].id).toBe("call_3");
  });

  it("returns messages unchanged if there are no tool rounds", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "hello" },
    ];

    const prepared = prepareOpenAICompatibleMessagesForReasoning(messages);

    expect(prepared).toEqual(messages);
  });
});
