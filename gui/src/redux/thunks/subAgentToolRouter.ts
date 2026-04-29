import { Tool, ToolCall, ToolCallState } from "core";
import { BuiltInToolNames } from "core/tools/builtIn";

const SUB_AGENT_ROUTED_TOOLS = new Set<string>([
  BuiltInToolNames.GrepSearch,
  BuiltInToolNames.FileGlobSearch,
  BuiltInToolNames.CodebaseTool,
  BuiltInToolNames.GetProblems,
  BuiltInToolNames.ViewRepoMap,
  BuiltInToolNames.ViewSubdirectory,
]);

export interface SubAgentDelegation {
  toolCall: ToolCall;
  availableTools: Tool[];
}

export function getModelVisibleTools(tools: Tool[]): Tool[] {
  return tools.filter(
    (tool) => tool.function.name !== BuiltInToolNames.SubAgent,
  );
}

function hasConfiguredSubAgentModel(config: any): boolean {
  return !!(
    config?.selectedModelByRole?.subagent ?? config?.modelsByRole?.subagent?.[0]
  );
}

export function shouldRouteToolCallThroughSubAgent(
  toolName: string,
  config: any,
): boolean {
  return (
    hasConfiguredSubAgentModel(config) && SUB_AGENT_ROUTED_TOOLS.has(toolName)
  );
}

function getToolCallArgs(toolCallState: ToolCallState): Record<string, any> {
  if (
    toolCallState.parsedArgs &&
    typeof toolCallState.parsedArgs === "object" &&
    !Array.isArray(toolCallState.parsedArgs)
  ) {
    return toolCallState.parsedArgs;
  }

  try {
    return JSON.parse(toolCallState.toolCall.function.arguments || "{}");
  } catch {
    return {};
  }
}

export function buildSubAgentDelegation(
  toolCallState: ToolCallState,
  availableTools: Tool[],
  config: any,
): SubAgentDelegation | undefined {
  const originalToolName = toolCallState.toolCall.function.name;
  if (!shouldRouteToolCallThroughSubAgent(originalToolName, config)) {
    return undefined;
  }

  const modelVisibleTools = getModelVisibleTools(availableTools);
  const availableToolNames = new Set(
    modelVisibleTools.map((tool) => tool.function.name),
  );
  if (!availableToolNames.has(originalToolName)) {
    return undefined;
  }

  const allowedTools = [
    originalToolName,
    ...(availableToolNames.has(BuiltInToolNames.ManageTodoList)
      ? [BuiltInToolNames.ManageTodoList]
      : []),
  ];
  const routedAvailableTools = modelVisibleTools.filter((tool) =>
    allowedTools.includes(tool.function.name),
  );
  const args = getToolCallArgs(toolCallState);
  const argsJson = JSON.stringify(args);

  const prompt = [
    `The main agent requested the ${originalToolName} tool call below.`,
    "Execute this tool call using the available tools, then return the result and any important evidence in your structured final response.",
    "Do not modify files unless the requested tool itself requires it.",
    "",
    `Tool: ${originalToolName}`,
    `Arguments: ${argsJson}`,
  ].join("\n");

  return {
    toolCall: {
      id: toolCallState.toolCall.id,
      type: "function",
      function: {
        name: BuiltInToolNames.SubAgent,
        arguments: JSON.stringify({
          description: `Run ${originalToolName}`,
          prompt,
          allowedTools,
        }),
      },
    },
    availableTools: routedAvailableTools,
  };
}
