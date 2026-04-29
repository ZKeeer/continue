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
import { getOptionalStringArg, getStringArg } from "../parseArgs";

const MAX_SUB_AGENT_ITERATIONS = 15;
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// Tool names whose primary effect is writing/modifying a file
const FILE_WRITE_TOOLS = new Set<string>([
  BuiltInToolNames.EditExistingFile,
  BuiltInToolNames.CreateNewFile,
  BuiltInToolNames.MultiEdit,
  BuiltInToolNames.SingleFindAndReplace,
]);

/** Tools whose invocation counts as a verification step */
const VERIFICATION_TOOLS = new Set<string>([
  BuiltInToolNames.GetProblems,
  "run_terminal",
  "terminal",
]);

const SUB_AGENT_SYSTEM_PREFIX = `You are a sub-agent executing an independent task. Complete the task thoroughly and return a structured summary of what you accomplished. You have access to tools to read/write files, run commands, search code, etc. Work autonomously — you cannot ask clarifying questions.

## Task Execution Protocol
1. Start by calling manage_todo_list to list your planned steps (3-7 items)
2. Mark each step as completed immediately after finishing it
3. After any file edits, call get_problems to verify no compile errors were introduced
4. When done, all todos should be completed or have a reason noted

## Required Final Response Format
Your FINAL response (when you have no more tool calls to make) MUST end with this exact block:

---RESULT-V2---
{
  "summary": "one paragraph describing what you accomplished",
  "evidence": ["key fact or finding 1", "key fact or finding 2"],
  "verificationRun": ["e.g. get_problems: 0 errors", "npm test: 5 passed"],
  "failureReason": null,
  "nextRecommendedAction": "what the caller should do next, or empty string if none"
}
---END-V2---

Rules:
- Set failureReason to null if successful, or a string describing WHY the task failed/is incomplete
- verificationRun must list every verification step you performed and its outcome; use [] if none
- evidence should be concrete facts (file names, error messages, test counts) not vague statements
- nextRecommendedAction should be actionable; use "" if task is fully self-contained`;

// ── S-3: Structured result protocol v2 ────────────────────────────────────
export interface SubAgentStructuredResult {
  summary: string;
  evidence: string[];
  verificationRun: string[];
  failureReason: string | null;
  nextRecommendedAction: string;
}

/**
 * Extract the ---RESULT-V2--- JSON block the sub-agent is instructed to append
 * at the end of its final response.  Returns null on parse failure so callers
 * can fall back gracefully to the raw text.
 */
function parseStructuredResult(text: string): SubAgentStructuredResult | null {
  const match = text.match(/---RESULT-V2---\s*([\s\S]*?)\s*---END-V2---/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    let failureReason: string | null = null;
    if (parsed.failureReason !== null && parsed.failureReason !== undefined) {
      failureReason = String(parsed.failureReason);
    }

    return {
      summary: String(parsed.summary ?? ""),
      evidence: Array.isArray(parsed.evidence)
        ? parsed.evidence.map(String)
        : [],
      verificationRun: Array.isArray(parsed.verificationRun)
        ? parsed.verificationRun.map(String)
        : [],
      failureReason,
      nextRecommendedAction: String(parsed.nextRecommendedAction ?? ""),
    };
  } catch {
    return null;
  }
}

/**
 * Strip the ---RESULT-V2--- block from the raw final response so it isn't
 * shown to the user as raw JSON.
 */
function stripResultBlock(text: string): string {
  return text.replace(/\s*---RESULT-V2---[\s\S]*?---END-V2---\s*$/, "").trim();
}

/**
 * Synthesize a V2 result for code paths where the sub-agent never produced
 * a RESULT-V2 block (timeout, max-iterations, or unrecoverable error).
 */
function synthesizeV2(
  status: "Completed" | "Incomplete" | "Failed",
  summary: string,
  failureReason: string | null,
  nextRecommendedAction: string,
  modifiedFiles: string[],
): SubAgentStructuredResult {
  return {
    summary,
    evidence: modifiedFiles.map((f) => `Modified: ${f}`),
    verificationRun: [],
    failureReason,
    nextRecommendedAction,
  };
}
// ─────────────────────────────────────────────────────────────────────────────

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

/** Format the final result as structured Markdown (v2 protocol) */
function buildResultContent(
  description: string,
  rawSummary: string,
  iterations: number,
  toolsUsed: Set<string>,
  modifiedFiles: string[],
  status: "Completed" | "Incomplete" | "Failed",
  structured: SubAgentStructuredResult | null,
  modelTitle: string,
): string {
  // Prefer the structured summary; fall back to stripped raw text
  const summaryText =
    structured?.summary || stripResultBlock(rawSummary) || rawSummary;

  const lines: string[] = [
    `## Sub-Agent Result: ${description}`,
    "",
    `**Status**: ${status}`,
    `**Iterations**: ${iterations}/${MAX_SUB_AGENT_ITERATIONS}`,
    `Model Used: ${modelTitle}`,
    "",
    "### Summary",
    summaryText,
  ];

  // evidence (V2)
  if (structured?.evidence && structured.evidence.length > 0) {
    lines.push("", "### Evidence");
    structured.evidence.forEach((e) => lines.push(`- ${e}`));
  }

  // files modified — merge tool-call tracking with what sub-agent reported
  const fileSet = new Set(modifiedFiles);
  if (fileSet.size > 0) {
    lines.push("", "### Files Modified");
    fileSet.forEach((f) => lines.push(`- ${f}`));
  }

  // verification (V2)
  const verificationLines = structured?.verificationRun ?? [];
  if (verificationLines.length > 0) {
    lines.push("", "### Verification");
    verificationLines.forEach((v) => lines.push(`- ${v}`));
  }

  // failure reason (V2)
  if (structured?.failureReason) {
    lines.push("", "### Failure Reason");
    lines.push(structured.failureReason);
  }

  // next recommended action (V2)
  if (structured?.nextRecommendedAction) {
    lines.push("", "### Next Recommended Action");
    lines.push(structured.nextRecommendedAction);
  }

  if (toolsUsed.size > 0) {
    lines.push("", "### Tools Used");
    lines.push([...toolsUsed].join(", "));
  }

  return lines.join("\n");
}

function getSubAgentModel(config: any): any | undefined {
  return (
    config?.selectedModelByRole?.subagent ?? config?.modelsByRole?.subagent?.[0]
  );
}

function getModelTitle(llm: any): string {
  return llm?.title ?? llm?.model ?? llm?.modelName ?? "unknown";
}

function findRequestedSubAgentModel(config: any, requestedModel: string) {
  const models = config?.modelsByRole?.subagent ?? [];
  const requested = requestedModel.trim();
  return models.find((model: any) =>
    [model?.title, model?.model, model?.modelName]
      .filter(Boolean)
      .includes(requested),
  );
}

export const subAgentImpl: ToolImpl = async (args, extras) => {
  const description = getStringArg(args, "description");
  const prompt = getStringArg(args, "prompt");
  const requestedModel = getOptionalStringArg(args, "model", true)?.trim();
  // 2.5: Optional tool whitelist
  const allowedTools = Array.isArray(args.allowedTools)
    ? (args.allowedTools as string[])
    : undefined;

  const requestedLlm = requestedModel
    ? findRequestedSubAgentModel(extras.config, requestedModel)
    : undefined;
  if (requestedModel && !requestedLlm) {
    return [
      {
        name: "Sub-Agent Configuration Error",
        description: "Requested model is not available for sub-agent use",
        content: `Model "${requestedModel}" is not configured for sub-agent use. Choose one of the listed sub-agent models or omit model to use the default.`,
      },
    ];
  }

  const llm = requestedLlm ?? getSubAgentModel(extras.config) ?? extras.llm;
  if (!llm) {
    return [
      {
        name: "Sub-Agent Configuration Error",
        description: "No sub-agent model configured",
        content:
          "No sub-agent model or parent chat model configured. Add a model with `roles: [subagent]`, select a sub-agent model, or configure a chat model before dispatching sub-agent tasks.",
      },
    ];
  }
  const modelTitle = getModelTitle(llm);

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
          const toolAllowed = toolSchemas.some(
            (schema: any) => schema.function.name === tc.name,
          );
          if (!toolAllowed) {
            throw new Error(
              `Tool ${tc.name} is not available to this sub-agent`,
            );
          }
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
    const modifiedFiles = extractModifiedFiles(allToolCallsExecuted);
    const structured = synthesizeV2(
      "Failed",
      `Sub-agent timed out after ${TIMEOUT_MS / 1000}s.`,
      `Execution exceeded the ${TIMEOUT_MS / 1000}s wall-clock limit.`,
      "Split the task into smaller sub-tasks and re-dispatch.",
      modifiedFiles,
    );
    return [
      {
        name: "Sub-Agent Error",
        description: `Timed out: ${description}`,
        content: buildResultContent(
          description,
          structured.summary,
          iterations,
          toolNamesUsed,
          modifiedFiles,
          "Failed",
          structured,
          modelTitle,
        ),
      },
    ];
  }

  const hitMaxIterations =
    !finalResponse && iterations >= MAX_SUB_AGENT_ITERATIONS;
  if (hitMaxIterations) {
    finalResponse = `Sub-agent reached maximum iterations (${MAX_SUB_AGENT_ITERATIONS}). Last messages may contain partial results.`;
  }

  const modifiedFiles = extractModifiedFiles(allToolCallsExecuted);
  const status: "Completed" | "Incomplete" = hitMaxIterations
    ? "Incomplete"
    : "Completed";

  // S-3: parse structured result block from the sub-agent's final response.
  // Fall back to synthesized V2 when the block is absent (max-iter path) so
  // ALL exit paths produce the same homogeneous protocol.
  const structuredFromModel = parseStructuredResult(finalResponse);
  const structured: SubAgentStructuredResult =
    structuredFromModel ??
    synthesizeV2(
      status,
      stripResultBlock(finalResponse) || finalResponse,
      hitMaxIterations
        ? `Reached the maximum iteration limit (${MAX_SUB_AGENT_ITERATIONS}) without completing the task.`
        : null,
      hitMaxIterations
        ? "Re-dispatch with a narrower, more focused sub-task."
        : "",
      modifiedFiles,
    );

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
        structured,
        modelTitle,
      ),
    },
  ];
};
