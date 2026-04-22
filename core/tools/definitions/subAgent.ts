import { Tool } from "../..";
import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "../builtIn";

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
