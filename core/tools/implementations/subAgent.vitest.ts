import { describe, expect, it, vi } from "vitest";
import { IDE, ToolExtras } from "../..";
import {
  getSubAgentModelContext,
  subAgentTool,
  withSubAgentModelContext,
} from "../definitions/subAgent";
import { subAgentImpl } from "./subAgent";

function makeLlm(title: string) {
  return {
    title,
    model: title.toLowerCase().replace(/\s+/g, "-"),
    providerName: "mock",
    streamChat: vi.fn(async function* () {
      yield {
        role: "assistant",
        content: `Done.\n\n---RESULT-V2---\n{"summary":"completed","evidence":[],"verificationRun":[],"failureReason":null,"nextRecommendedAction":""}\n---END-V2---`,
      };
    }),
  } as any;
}

function makeExtras(
  config: any,
  parentLlm = makeLlm("Chat Model"),
): ToolExtras {
  const ide = {
    getWorkspaceDirs: vi.fn().mockResolvedValue(["file:///workspace"]),
  } as unknown as IDE;

  return {
    ide,
    llm: parentLlm,
    fetch: vi.fn() as any,
    tool: {} as any,
    config,
    toolCallId: "sub-agent-test",
  } as ToolExtras;
}

describe("subAgentImpl model selection", () => {
  it("should use the explicitly requested subagent model", async () => {
    const fast = makeLlm("Fast Subagent");
    const deep = makeLlm("Deep Subagent");
    const parent = makeLlm("Chat Model");

    const result = await subAgentImpl(
      {
        description: "model test",
        prompt: "complete task",
        model: "Deep Subagent",
      },
      makeExtras(
        {
          selectedModelByRole: { subagent: fast },
          modelsByRole: { subagent: [fast, deep] },
          tools: [],
        },
        parent,
      ),
    );

    expect(deep.streamChat).toHaveBeenCalled();
    expect(fast.streamChat).not.toHaveBeenCalled();
    expect(parent.streamChat).not.toHaveBeenCalled();
    expect(result[0].content).toContain("Model Used: Deep Subagent");
  });

  it("should prefer selectedModelByRole.subagent", async () => {
    const selected = makeLlm("Selected Subagent");
    const defaultModel = makeLlm("Default Subagent");
    const parent = makeLlm("Chat Model");

    const result = await subAgentImpl(
      { description: "model test", prompt: "complete task" },
      makeExtras(
        {
          selectedModelByRole: { subagent: selected },
          modelsByRole: { subagent: [defaultModel] },
          tools: [],
        },
        parent,
      ),
    );

    expect(selected.streamChat).toHaveBeenCalled();
    expect(defaultModel.streamChat).not.toHaveBeenCalled();
    expect(parent.streamChat).not.toHaveBeenCalled();
    expect(result[0].content).toContain("Model Used: Selected Subagent");
  });

  it("should default to the first configured subagent model", async () => {
    const first = makeLlm("First Subagent");
    const second = makeLlm("Second Subagent");
    const parent = makeLlm("Chat Model");

    const result = await subAgentImpl(
      { description: "model test", prompt: "complete task" },
      makeExtras(
        {
          selectedModelByRole: { subagent: null },
          modelsByRole: { subagent: [first, second] },
          tools: [],
        },
        parent,
      ),
    );

    expect(first.streamChat).toHaveBeenCalled();
    expect(second.streamChat).not.toHaveBeenCalled();
    expect(parent.streamChat).not.toHaveBeenCalled();
    expect(result[0].content).toContain("Model Used: First Subagent");
  });

  it("should fall back to the parent chat model when no subagent model exists", async () => {
    const parent = makeLlm("Chat Model");

    const result = await subAgentImpl(
      { description: "model test", prompt: "complete task" },
      makeExtras(
        {
          selectedModelByRole: { subagent: null },
          modelsByRole: { subagent: [] },
          tools: [],
        },
        parent,
      ),
    );

    expect(parent.streamChat).toHaveBeenCalled();
    expect(result[0].content).toContain("Model Used: Chat Model");
  });

  it("should reject an explicitly requested model that is not a configured subagent model", async () => {
    const parent = makeLlm("Chat Model");

    const result = await subAgentImpl(
      {
        description: "model test",
        prompt: "complete task",
        model: "Missing Model",
      },
      makeExtras(
        {
          selectedModelByRole: { subagent: null },
          modelsByRole: { subagent: [] },
          tools: [],
        },
        parent,
      ),
    );

    expect(parent.streamChat).not.toHaveBeenCalled();
    expect(result[0].name).toBe("Sub-Agent Configuration Error");
    expect(result[0].content).toContain("not configured for sub-agent use");
  });
});

describe("sub-agent tool model context", () => {
  it("should inject subagent model names and mark the default", () => {
    const models = [
      { title: "Fast Subagent", model: "fast", providerName: "openai" },
      { title: "Deep Subagent", model: "deep", providerName: "anthropic" },
    ] as any[];

    const context = getSubAgentModelContext(models, models[0]);
    const tool = withSubAgentModelContext(subAgentTool, models, models[0]);

    expect(context).toContain("Fast Subagent");
    expect(context).toContain("Deep Subagent");
    expect(context).toContain("default");
    expect(tool.systemMessageDescription?.prefix).toContain("Fast Subagent");
    expect(tool.systemMessageDescription?.prefix).toContain("Deep Subagent");
    expect(tool.systemMessageDescription?.prefix).toContain("model");
    const parameters = tool.function.parameters;
    if (!parameters) {
      throw new Error("Expected sub-agent tool parameters to be defined");
    }

    expect((parameters.properties as any).model).toBeDefined();
  });

  it("should include the strengthened delegation rubric", () => {
    const tool = withSubAgentModelContext(subAgentTool, [], undefined);
    const prefix = tool.systemMessageDescription?.prefix ?? "";

    expect(prefix).toContain("high token");
    expect(prefix).toContain("weak dependency on your current context");
    expect(prefix).toContain("do not delegate");
  });
});
