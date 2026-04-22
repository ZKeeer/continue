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
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// Tool names whose primary effect is writing/modifying a file
const FILE_WRITE_TOOLS = new Set<string>([
  BuiltInToolNames.EditExistingFile,
  BuiltInToolNames.CreateNewFile,
  BuiltInToolNames.MultiEdit,
  BuiltInToolNames.SingleFindAndReplace,
]);

const SUB_AGENT_SYSTEM_PREFIX = `You are a sub-agent executing an independent task. Complete the task thoroughly and return a concise summary of what you accomplished. You have access to tools to read/write files, run commands, search code, etc. Work autonomously — you cannot ask clarifying questions.

## Task Execution Protocol
1. Start by calling manage_todo_list to list your planned steps (3-7 items)
2. Mark each step as completed immediately after finishing it
3. When done, all todos should be completed or have a reason noted`;

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

/** Extract file paths written/modified by file-mutation tool calls */
function extractModifiedFiles(allToolCalls: ToolCallParsed[]): string[] {
  const seen = new Set<string>();
  for (const tc of allToolCalls) {
    if (FILE_WRITE_TOOLS.has(tc.name)) {
      const fp = tc.arguments?.filepath;
      if (fp && typeof fp === "string") {
        seen.add(fp);
      }
    }
  }
  return [...seen];
}

/** Format the final result as structured Markdown */
function buildResultContent(
  description: string,
  summary: string,
  iterations: number,
  toolsUsed: Set<string>,
  modifiedFiles: string[],
  status: "Completed" | "Incomplete" = "Completed",
): string {
  const lines: string[] = [
    `## Sub-Agent Result: ${description}`,
    "",
    `**Status**: ${status}`,
    `**Iterations**: ${iterations}/${MAX_SUB_AGENT_ITERATIONS}`,
    "",
    "### Summary",
    summary,
  ];

  if (modifiedFiles.length > 0) {
    lines.push("", "### Files Modified");
    modifiedFiles.forEach((f) => lines.push(`- ${f}`));
  }

  if (toolsUsed.size > 0) {
    lines.push("", "### Tools Used");
    lines.push([...toolsUsed].join(", "));
  }

  return lines.join("\n");
}

export const subAgentImpl: ToolImpl = async (args, extras) => {
  const description = getStringArg(args, "description");
  const prompt = getStringArg(args, "prompt");
  // 2.5: Optional tool whitelist
  const allowedTools = Array.isArray(args.allowedTools)
    ? (args.allowedTools as string[])
    : undefined;

  // 2.1: Use dedicated subagent model role if configured; fall back to parent LLM
  const llm =
    (extras.config as any)?.selectedModelByRole?.["subagent"] ?? extras.llm;

  // 2.4: Auto-inject workspace dirs so sub-agent knows where files live
  let workspaceContext = "";
  try {
    const workspaceDirs = await extras.ide.getWorkspaceDirs();
    if (workspaceDirs.length > 0) {
      workspaceContext = `\n\nWorkspace directories: ${workspaceDirs.join(", ")}`;
    }
  } catch {
    // Non-fatal: IDE may not expose workspace dirs in all environments
  }

  const systemContent = `${SUB_AGENT_SYSTEM_PREFIX}${workspaceContext}`;

  const messages: ChatMessage[] = [
    { role: "system", content: systemContent },
    { role: "user", content: prompt },
  ];

  // 2.5: Filter available tool schemas to the whitelist if provided
  const allToolSchemas = getAvailableToolSchemas(extras.config);
  const toolSchemas = allowedTools
    ? allToolSchemas.filter((s: any) => allowedTools.includes(s.function.name))
    : allToolSchemas;
  const abortController = new AbortController();

  // Report initial progress
  if (extras.onPartialOutput) {
    extras.onPartialOutput({
      toolCallId: extras.toolCallId || "",
      contextItems: [
        {
          name: "Sub-Agent",
          description: `Running: ${description}`,
          content: `Sub-agent started: ${description}\n\nWorking...`,
        },
      ],
    });
  }

  let finalResponse = "";
  let iterations = 0;
  const allToolCallsExecuted: ToolCallParsed[] = [];
  const toolNamesUsed = new Set<string>();

  // 2.3: Wall-clock timeout — abort the LLM stream and surface a clean error
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, TIMEOUT_MS);

  try {
    while (iterations < MAX_SUB_AGENT_ITERATIONS && !timedOut) {
      iterations++;

      const assistantMessage: AssistantChatMessage = {
        role: "assistant",
        content: "",
      };

      const generator = llm.streamChat(messages, abortController.signal, {
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

      if (timedOut) break;

      messages.push(assistantMessage);

      const toolCalls = parseToolCallsFromAssistant(assistantMessage);

      if (toolCalls.length === 0) {
        finalResponse =
          typeof assistantMessage.content === "string"
            ? assistantMessage.content
            : "";
        break;
      }

      for (const tc of toolCalls) {
        toolNamesUsed.add(tc.name);
        allToolCallsExecuted.push(tc);

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

        messages.push({
          role: "tool",
          content: toolResult.map((item) => item.content).join("\n\n"),
          toolCallId: tc.id,
        });
      }

      // Report progress after each iteration
      if (extras.onPartialOutput) {
        // Build a richer content line: tool_name(key_param=value) per call
        const progressLines = toolCalls.map((tc) => {
          const keyArgs: string[] = [];
          for (const key of [
            "filepath",
            "query",
            "symbol",
            "pattern",
            "command",
            "url",
            "description",
          ]) {
            const v = tc.arguments?.[key];
            if (v && typeof v === "string") {
              keyArgs.push(
                `${key}=${v.length > 60 ? v.slice(0, 57) + "..." : v}`,
              );
              break; // show only the most significant param
            }
          }
          return keyArgs.length > 0 ? `${tc.name}(${keyArgs[0]})` : tc.name;
        });
        extras.onPartialOutput({
          toolCallId: extras.toolCallId || "",
          contextItems: [
            {
              name: "Sub-Agent",
              description: `Running: ${description} (${iterations}/${MAX_SUB_AGENT_ITERATIONS})`,
              content: progressLines.join("\n"),
            },
          ],
        });
      }
    }
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (timedOut) {
    return [
      {
        name: "Sub-Agent Error",
        description: `Timed out: ${description}`,
        content: `Sub-agent "${description}" timed out after ${TIMEOUT_MS / 1000}s. Consider splitting the task into smaller sub-tasks.`,
      },
    ];
  }

  const hitMaxIterations =
    !finalResponse && iterations >= MAX_SUB_AGENT_ITERATIONS;
  if (hitMaxIterations) {
    finalResponse = `Sub-agent reached maximum iterations (${MAX_SUB_AGENT_ITERATIONS}). Last messages may contain partial results.`;
  }

  const modifiedFiles = extractModifiedFiles(allToolCallsExecuted);
  const status = hitMaxIterations ? "Incomplete" : "Completed";

  return [
    {
      name: hitMaxIterations ? "Sub-Agent Incomplete" : "Sub-Agent Result",
      description: hitMaxIterations
        ? `Incomplete: ${description}`
        : `Completed: ${description}`,
      content: buildResultContent(
        description,
        finalResponse,
        iterations,
        toolNamesUsed,
        modifiedFiles,
        status,
      ),
    },
  ];
};
