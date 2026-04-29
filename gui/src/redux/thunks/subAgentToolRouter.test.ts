import { ToolCallState } from "core";
import { serializeTool } from "core/tools";
import { BuiltInToolNames } from "core/tools/builtIn";
import {
  editFileTool,
  grepSearchTool,
  manageTodoListTool,
  subAgentTool,
} from "core/tools/definitions";
import { describe, expect, it } from "vitest";
import {
  buildSubAgentDelegation,
  getModelVisibleTools,
  shouldRouteToolCallThroughSubAgent,
} from "./subAgentToolRouter";

const grepTool = serializeTool(grepSearchTool);
const editTool = serializeTool(editFileTool);
const manageTodoTool = serializeTool(manageTodoListTool);
const subAgentSerializedTool = serializeTool(subAgentTool);

const configWithSubAgentModel = {
  selectedModelByRole: {
    subagent: {
      title: "Qwen Sub-Agent",
      model: "qwen-sub-agent",
      provider: "openai",
    },
  },
  modelsByRole: {
    subagent: [
      {
        title: "Qwen Sub-Agent",
        model: "qwen-sub-agent",
        provider: "openai",
      },
    ],
  },
};

function toolCallStateFor(
  name: string,
  args: Record<string, unknown>,
): ToolCallState {
  return {
    toolCallId: "tool-call-1",
    status: "calling",
    toolCall: {
      id: "tool-call-1",
      type: "function",
      function: {
        name,
        arguments: JSON.stringify(args),
      },
    },
    parsedArgs: args,
  };
}

describe("subAgentToolRouter", () => {
  it("removes sub_agent from model-visible tools", () => {
    const visibleTools = getModelVisibleTools([
      grepTool,
      subAgentSerializedTool,
      manageTodoTool,
    ]);

    expect(visibleTools.map((tool) => tool.function.name)).toEqual([
      BuiltInToolNames.GrepSearch,
      BuiltInToolNames.ManageTodoList,
    ]);
  });

  it("routes configured exploration tools through sub-agent", () => {
    expect(
      shouldRouteToolCallThroughSubAgent(
        BuiltInToolNames.GrepSearch,
        configWithSubAgentModel,
      ),
    ).toBe(true);
    expect(
      shouldRouteToolCallThroughSubAgent(
        BuiltInToolNames.EditExistingFile,
        configWithSubAgentModel,
      ),
    ).toBe(false);
    expect(
      shouldRouteToolCallThroughSubAgent(BuiltInToolNames.GrepSearch, {
        selectedModelByRole: {},
        modelsByRole: { subagent: [] },
      }),
    ).toBe(false);
  });

  it("builds a sub-agent delegation request for routed tools", () => {
    const delegation = buildSubAgentDelegation(
      toolCallStateFor(BuiltInToolNames.GrepSearch, { query: "apply state" }),
      [grepTool, subAgentSerializedTool, manageTodoTool, editTool],
      configWithSubAgentModel,
    );

    expect(delegation).toBeDefined();
    expect(delegation?.toolCall.function.name).toBe(BuiltInToolNames.SubAgent);
    expect(delegation?.toolCall.id).toBe("tool-call-1");

    const routedArgs = JSON.parse(
      delegation?.toolCall.function.arguments ?? "{}",
    );
    expect(routedArgs.description).toBe("Run grep_search");
    expect(routedArgs.prompt).toContain("grep_search");
    expect(routedArgs.prompt).toContain('"query":"apply state"');
    expect(routedArgs.allowedTools).toEqual([
      BuiltInToolNames.GrepSearch,
      BuiltInToolNames.ManageTodoList,
    ]);

    expect(
      delegation?.availableTools.map((tool) => tool.function.name),
    ).toEqual([BuiltInToolNames.GrepSearch, BuiltInToolNames.ManageTodoList]);
  });
});
