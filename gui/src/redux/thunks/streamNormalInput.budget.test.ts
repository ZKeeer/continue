import { describe, expect, it } from "vitest";
import { DEFAULT_UI_SLICE } from "../slices/uiSlice";
import {
  DEFAULT_AGENT_MAX_BUDGET_DURATION_MS,
  buildAgentBudgetStop,
  getAgentMaxBudgetIterations,
} from "./agentBudget";

describe("streamNormalInput agent iteration budget", () => {
  it("should default max budget iterations to 200", async () => {
    expect(DEFAULT_UI_SLICE.agent.maxBudgetIterations).toBe(200);

    const maxBudgetIterations = getAgentMaxBudgetIterations(undefined);
    const budgetStop = buildAgentBudgetStop({
      depth: 200,
      maxBudgetIterations,
      agentRunStartTime: 0,
      nowMs: 0,
    });

    expect(budgetStop.inlineErrorMessage).toMatchObject({
      type: "budget-exceeded",
      iterations: 200,
      maxBudgetIterations: 200,
    });
    expect(budgetStop.budgetStopMessage.content).toContain(
      "Iteration budget exceeded (200 iterations / 200 limit)",
    );
  });

  it("should use custom max budget iterations from UI state", async () => {
    const maxBudgetIterations = getAgentMaxBudgetIterations({
      maxBudgetIterations: 20,
    });
    const budgetStop = buildAgentBudgetStop({
      depth: 20,
      maxBudgetIterations,
      agentRunStartTime: 0,
      nowMs: 0,
    });

    expect(budgetStop.inlineErrorMessage).toMatchObject({
      type: "budget-exceeded",
      iterations: 20,
      maxBudgetIterations: 20,
    });
    expect(budgetStop.budgetStopMessage.content).toContain(
      "Iteration budget exceeded (20 iterations / 20 limit)",
    );
  });

  it("should define an 8 hour wall-clock budget", async () => {
    expect(DEFAULT_AGENT_MAX_BUDGET_DURATION_MS).toBe(8 * 60 * 60 * 1000);
  });
});
