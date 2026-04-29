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
  it("removes historical thinking and reasoning fields from outbound messages", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "user" },
      { role: "thinking", content: "private reasoning" },
      {
        role: "assistant",
        content: "visible answer",
        reasoning_content: "provider reasoning",
        reasoning_details: [{ signature: "sig" }],
      } as ChatMessage,
    ];

    const prepared = prepareOpenAICompatibleMessagesForReasoning(messages);

    expect(prepared.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
    ]);
    expect(prepared[2]).toEqual({
      role: "assistant",
      content: "visible answer",
    });
  });

  it("flattens older completed tool rounds while preserving the latest two rounds", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "implement feature" },
      ...toolRound(1),
      ...toolRound(2),
      ...toolRound(3),
      ...toolRound(4),
    ];

    const prepared = prepareOpenAICompatibleMessagesForReasoning(messages, {
      keepRecentStructuredToolRounds: 2,
    });

    expect(prepared.map((message) => message.role)).toEqual([
      "system",
      "user",
      "user",
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
    ]);
    expect(prepared[2].content).toContain("Previous tool round 1");
    expect(prepared[2].content).toContain("read_file");
    expect(prepared[2].content).toContain("file_1.ts contents");
    expect((prepared[4] as any).toolCalls?.[0].id).toBe("call_3");
    expect((prepared[6] as any).toolCalls?.[0].id).toBe("call_4");
  });

  it("counts concurrent tool calls from one assistant message as one round", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "implement feature" },
      ...toolRound(1),
      ...multiToolRound(2, 3),
      ...toolRound(3),
    ];

    const prepared = prepareOpenAICompatibleMessagesForReasoning(messages, {
      keepRecentStructuredToolRounds: 2,
    });

    expect(prepared.map((message) => message.role)).toEqual([
      "system",
      "user",
      "user",
      "assistant",
      "tool",
      "tool",
      "tool",
      "assistant",
      "tool",
    ]);
    expect(prepared[2].content).toContain("Previous tool round 1");
    expect((prepared[3] as any).toolCalls).toHaveLength(3);
    expect(
      (prepared[3] as any).toolCalls?.map((toolCall: any) => toolCall.id),
    ).toEqual(["call_2_1", "call_2_2", "call_2_3"]);
    expect((prepared[7] as any).toolCalls?.[0].id).toBe("call_3");
  });

  it("keeps previously flattened round summaries stable when another round ages out", () => {
    const baseMessages: ChatMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "implement feature" },
      ...toolRound(1),
      ...toolRound(2),
      ...toolRound(3),
      ...toolRound(4),
    ];
    const extendedMessages: ChatMessage[] = [...baseMessages, ...toolRound(5)];

    const basePrepared = prepareOpenAICompatibleMessagesForReasoning(
      baseMessages,
      { keepRecentStructuredToolRounds: 2 },
    );
    const extendedPrepared = prepareOpenAICompatibleMessagesForReasoning(
      extendedMessages,
      { keepRecentStructuredToolRounds: 2 },
    );

    expect(extendedPrepared[2]).toEqual(basePrepared[2]);
    expect(extendedPrepared[3]).toEqual(basePrepared[3]);
    expect(extendedPrepared[4].content).toContain("Previous tool round 3");
  });
});
