import { Tool } from "../..";
import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "../builtIn";

function getModelDisplayName(model: any): string {
  return model?.title ?? model?.model ?? model?.modelName ?? "unknown";
}

function getModelProvider(model: any): string {
  return (
    model?.providerName ??
    model?.underlyingProviderName ??
    model?.provider ??
    "unknown"
  );
}

export function getSubAgentModelContext(
  models: any[] = [],
  defaultModel?: any,
): string {
  if (!models.length) {
    return "Sub-agent models: none configured. If no model is specified, the runtime falls back to the current chat model.";
  }

  const defaultName = defaultModel
    ? getModelDisplayName(defaultModel)
    : undefined;
  const lines = models.map((model, index) => {
    const name = getModelDisplayName(model);
    const marker =
      name === defaultName || (!defaultName && index === 0) ? " (default)" : "";
    return `- ${name}${marker} — model: ${model?.model ?? "unknown"}, provider: ${getModelProvider(model)}`;
  });

  return `Sub-agent models available to the runtime:\n${lines.join("\n")}\nYou may pass the optional model parameter using one of the listed model names. If omitted, the runtime uses selectedModelByRole.subagent, otherwise the first configured sub-agent model.`;
}

const DELEGATION_RUBRIC = `
DELEGATION RUBRIC:
- Prefer sub-agents for independent work that would consume high token volume and has weak dependency on your current context.
- Prefer sub-agents for multi-route investigation, reading 3+ unrelated files, independent validation, or parallelizable tool calls.
- do not delegate single-file small edits, tasks with strict sequential dependency, or work the user explicitly asked the main agent to do directly.`;

export const subAgentTool: Tool = {
  type: "function",
  displayTitle: "Sub-Agent",
  wouldLikeTo: 'dispatch sub-agent: "{{{ description }}}"',
  isCurrently: 'running sub-agent: "{{{ description }}}"',
  hasAlready: 'completed sub-agent: "{{{ description }}}"',
  readonly: true,
  group: BUILT_IN_GROUP_NAME,
  function: {
    name: BuiltInToolNames.SubAgent,
    description:
      "Launch a sub-agent to handle an independent task autonomously. The sub-agent has access to the same tools and can perform multi-step work. Use this for tasks that can be done independently without needing results from other ongoing work. The sub-agent returns a summary of what it accomplished.",
    parameters: {
      type: "object",
      required: ["description", "prompt"],
      properties: {
        description: {
          type: "string",
          description:
            "A short (3-5 word) description of the task for display purposes",
        },
        prompt: {
          type: "string",
          description:
            "Detailed instructions for the sub-agent. Include all necessary context, file paths, and expected outcomes. The sub-agent cannot ask clarifying questions.",
        },
        model: {
          type: "string",
          description:
            "Optional sub-agent model name. Must exactly match one of the sub-agent model names listed in this tool description. If omitted, the runtime uses the configured default.",
        },
        allowedTools: {
          type: "array",
          items: { type: "string" },
          description:
            'Optional whitelist of tool names the sub-agent is allowed to use. If omitted, all available tools are enabled. Example: ["read_file", "grep_search"] for a read-only agent.',
        },
      },
    },
  },
  defaultToolPolicy: "allowedWithoutPermission",
  systemMessageDescription: {
    prefix: `To dispatch independent tasks to a sub-agent, use the ${BuiltInToolNames.SubAgent} tool. The sub-agent executes autonomously and returns a structured V2 result.

**V2 Result Fields** (always present in the tool message):
- **Status**: Completed / Incomplete / Failed
- **Summary**: what was accomplished
- **Evidence**: concrete facts/findings supporting the summary
- **Files Modified**: list of paths changed
- **Verification**: steps run (e.g. "get_problems: 0 errors") — empty if none
- **Failure Reason**: why the task failed or is incomplete (absent if successful)
- **Next Recommended Action**: what the caller should do next (absent if task is self-contained)

WHEN TO USE SUB-AGENTS (mandatory in these situations):
- You need to explore or investigate 2+ independent, unrelated problems simultaneously
- You need to read and analyze 3+ unrelated files to make a decision
- The task is clearly separable into "information gathering" and "implementation" phases — dispatch the gathering phase first
- Running tests, linting, or build commands and interpreting results
- Any multi-step investigation that would consume significant context

PARALLEL DISPATCH (V4): You MAY issue multiple ${BuiltInToolNames.SubAgent} calls in the SAME response turn. All calls execute concurrently. Use this when tasks are fully independent (no data dependency). Example: exploring two unrelated modules simultaneously. Each sub-agent call will resolve independently and all results appear before the next LLM turn.

SUB-AGENTS HELP CONSERVE YOUR CONTEXT WINDOW. Prefer dispatching a sub-agent for exploratory work instead of doing it yourself.

HANDLING SUB-AGENT RESULTS:
- Consume the structured fields directly — do NOT re-read files the sub-agent already confirmed in "Files Modified"
- If Status is Incomplete or Failed, read "Failure Reason" and "Next Recommended Action" before deciding how to proceed
- Do NOT silently retry the exact same prompt on failure — it will fail again; split or rephrase instead
- If Verification is empty, assume no validation was done; consider running get_problems yourself

Examples:`,
    exampleArgs: [
      ["description", "Explore auth module structure"],
      [
        "prompt",
        "Read the files in src/auth/ directory. Summarize the authentication flow, key functions, and how sessions are managed. List all exported functions with brief descriptions.",
      ],
    ],
  },
  toolCallIcon: "UserGroupIcon",
};

export function withSubAgentModelContext(
  tool: Tool,
  models: any[] = [],
  defaultModel?: any,
): Tool {
  const modelContext = getSubAgentModelContext(models, defaultModel);
  return {
    ...tool,
    function: {
      ...tool.function,
      description: `${tool.function.description}\n\n${modelContext}`,
    },
    systemMessageDescription: tool.systemMessageDescription
      ? {
          ...tool.systemMessageDescription,
          prefix: `${tool.systemMessageDescription.prefix}\n\n${modelContext}\n${DELEGATION_RUBRIC}`,
        }
      : undefined,
  };
}
