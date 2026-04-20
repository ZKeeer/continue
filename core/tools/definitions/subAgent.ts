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
      },
    },
  },
  defaultToolPolicy: "allowedWithoutPermission",
  systemMessageDescription: {
    prefix: `To dispatch independent tasks to a sub-agent, use the ${BuiltInToolNames.SubAgent} tool. The sub-agent executes autonomously and returns results.

WHEN TO USE SUB-AGENTS (strongly recommended):
- Exploring or searching across multiple files/directories (e.g., finding all usages, understanding code structure)
- Reading and analyzing large files or many files at once
- Independent research tasks that don't need results from other ongoing work
- Running tests, linting, or build commands and interpreting results
- Any multi-step investigation that would consume significant context

SUB-AGENTS HELP CONSERVE YOUR CONTEXT WINDOW. Prefer dispatching a sub-agent for exploratory work instead of doing it yourself. You can continue working on other tasks while the sub-agent completes its work.

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
