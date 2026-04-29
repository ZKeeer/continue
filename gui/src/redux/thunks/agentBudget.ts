import type { TodoItem } from "../slices/sessionSlice";
import { DEFAULT_AGENT_MAX_BUDGET_ITERATIONS } from "../slices/uiSlice";

export const DEFAULT_AGENT_MAX_BUDGET_DURATION_MS = 8 * 60 * 60 * 1000;

export interface AgentBudgetSettings {
  maxBudgetIterations?: number | null;
}

export interface AgentBudgetStopInput {
  depth: number;
  maxBudgetIterations: number;
  agentRunStartTime?: number;
  nowMs: number;
  todoItems?: TodoItem[];
  stopReason?: string;
}

export function getAgentMaxBudgetIterations(
  agentSettings?: AgentBudgetSettings,
): number {
  return (
    agentSettings?.maxBudgetIterations ?? DEFAULT_AGENT_MAX_BUDGET_ITERATIONS
  );
}

export function buildAgentBudgetStop(input: AgentBudgetStopInput) {
  const elapsedMs =
    input.agentRunStartTime !== undefined
      ? input.nowMs - input.agentRunStartTime
      : 0;
  const elapsedMin = Math.round(elapsedMs / 60_000);
  const todoItems = input.todoItems ?? [];
  const done = todoItems.filter((t) => t.status === "completed").length;
  const inProgress = todoItems.filter((t) => t.status === "in-progress").length;
  const remaining = todoItems.filter((t) => t.status === "not-started").length;
  const todoSummary =
    todoItems.length > 0
      ? `Plan progress: ${done}/${todoItems.length} done${inProgress > 0 ? `, ${inProgress} in-progress` : ""}, ${remaining} remaining`
      : "No task plan was created for this run.";

  const stopReason =
    input.stopReason ??
    `Iteration budget exceeded (${input.depth} iterations / ${input.maxBudgetIterations} limit)`;
  const todoMarkdown =
    todoItems.length > 0
      ? todoItems
          .map(
            (t) =>
              `- [${t.status === "completed" ? "x" : t.status === "in-progress" ? "~" : " "}] ${t.title}`,
          )
          .join("\n") + "\n\n"
      : "";

  return {
    elapsedMin,
    stopReason,
    todoSummary,
    budgetStopMessage: {
      role: "assistant" as const,
      content:
        `**⚠️ Agent Budget Stop**\n\n` +
        `**Reason**: ${stopReason}\n\n` +
        `**${todoSummary}**\n\n` +
        todoMarkdown +
        `**Remaining Risk**: Work may be incomplete. Review the last tool call outputs before continuing.\n\n` +
        `**Next Recommended Action**: Send a follow-up message to resume from the current state, or start a new session with a more focused scope.`,
    },
    inlineErrorMessage: {
      type: "budget-exceeded" as const,
      elapsedMin,
      iterations: input.depth,
      maxBudgetIterations: input.maxBudgetIterations,
      todoSummary,
    },
  };
}
