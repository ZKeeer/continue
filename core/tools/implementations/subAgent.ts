import { ToolImpl } from ".";
import {
  AssistantChatMessage,
  ChatMessage,
  ContextItem,
  Tool,
  ToolCallDelta,
} from "../..";
import { BuiltInToolNames } from "../builtIn";
import { callBuiltInTool } from "../callTool";
import { getStringArg } from "../parseArgs";

const MAX_SUB_AGENT_ITERATIONS = 15;
const SUB_AGENT_SYSTEM_PREFIX = `You are a sub-agent executing an independent task. Complete the task thoroughly and return a concise summary of what you accomplished. You have access to tools to read/write files, run commands, search code, etc. Work autonomously — you cannot ask clarifying questions.`;

interface ToolCallParsed {
  name: string;
  arguments: Record<string, any>;
  id: string;
}

function parseToolCallsFromAssistant(
  message: AssistantChatMessage,
): ToolCallParsed[] {
  if (!message.toolCalls || message.toolCalls.length === 0) return [];

  return message.toolCalls
    .map((tc: ToolCallDelta) => {
      if (!tc.function || !tc.function.name) return null;
      try {
        const args =
          typeof tc.function.arguments === "string"
            ? JSON.parse(tc.function.arguments)
            : tc.function.arguments || {};
        return {
          name: tc.function.name as string,
          arguments: args,
          id: tc.id || `call_${Date.now()}`,
        };
      } catch {
        return null;
      }
    })
    .filter((tc: ToolCallParsed | null): tc is ToolCallParsed => tc !== null);
}

function getAvailableToolSchemas(config: any): any[] {
  const tools = config?.tools || [];
  return tools
    .filter(
      (t: Tool) => t.function.name !== BuiltInToolNames.SubAgent, // prevent recursion
    )
    .map((t: Tool) => ({
      type: "function",
      function: {
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      },
    }));
}

export const subAgentImpl: ToolImpl = async (args, extras) => {
  const description = getStringArg(args, "description");
  const prompt = getStringArg(args, "prompt");

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: SUB_AGENT_SYSTEM_PREFIX,
    },
    {
      role: "user",
      content: prompt,
    },
  ];

  const toolSchemas = getAvailableToolSchemas(extras.config);
  const abortController = new AbortController();

  let finalResponse = "";
  let iterations = 0;

  // Report initial progress
  if (extras.onPartialOutput) {
    extras.onPartialOutput({
      toolCallId: extras.toolCallId || "",
      contextItems: [
        {
          name: "Sub-Agent",
          description: `Running: ${description}`,
          content: `Sub-agent started: ${description}\nPrompt: ${prompt}\n\nWorking...`,
        },
      ],
    });
  }

  while (iterations < MAX_SUB_AGENT_ITERATIONS) {
    iterations++;

    // Call LLM with tool schemas
    const assistantMessage: AssistantChatMessage = {
      role: "assistant",
      content: "",
    };

    const generator = extras.llm.streamChat(messages, abortController.signal, {
      tools: toolSchemas.length > 0 ? toolSchemas : undefined,
    });

    for await (const chunk of generator) {
      if (chunk.role === "assistant") {
        if (chunk.content) {
          assistantMessage.content =
            (assistantMessage.content || "") +
            (typeof chunk.content === "string" ? chunk.content : "");
        }
        if (chunk.toolCalls) {
          assistantMessage.toolCalls = [
            ...(assistantMessage.toolCalls || []),
            ...chunk.toolCalls,
          ];
        }
      }
    }

    messages.push(assistantMessage);

    // Parse tool calls
    const toolCalls = parseToolCallsFromAssistant(assistantMessage);

    if (toolCalls.length === 0) {
      // No tool calls — agent is done, extract final text response
      finalResponse =
        typeof assistantMessage.content === "string"
          ? assistantMessage.content
          : "";
      break;
    }

    // Execute each tool call
    for (const tc of toolCalls) {
      let toolResult: ContextItem[];
      try {
        toolResult = await callBuiltInTool(tc.name, tc.arguments, extras);
      } catch (e: any) {
        toolResult = [
          {
            name: "Error",
            description: `Tool ${tc.name} failed`,
            content: `Error: ${e.message || String(e)}`,
          },
        ];
      }

      const resultContent = toolResult.map((item) => item.content).join("\n\n");

      // Add tool result to messages
      messages.push({
        role: "tool",
        content: resultContent,
        toolCallId: tc.id,
      });
    }

    // Report progress
    if (extras.onPartialOutput) {
      extras.onPartialOutput({
        toolCallId: extras.toolCallId || "",
        contextItems: [
          {
            name: "Sub-Agent",
            description: `Running: ${description} (iteration ${iterations})`,
            content: `Sub-agent iteration ${iterations}/${MAX_SUB_AGENT_ITERATIONS}\nLast action: ${toolCalls.map((tc) => tc.name).join(", ")}`,
          },
        ],
      });
    }
  }

  if (!finalResponse && iterations >= MAX_SUB_AGENT_ITERATIONS) {
    finalResponse = `Sub-agent reached maximum iterations (${MAX_SUB_AGENT_ITERATIONS}). Last messages may contain partial results.`;
  }

  return [
    {
      name: "Sub-Agent Result",
      description: `Completed: ${description}`,
      content: finalResponse,
    },
  ];
};
