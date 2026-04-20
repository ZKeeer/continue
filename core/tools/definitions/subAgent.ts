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
    prefix: `To dispatch independent tasks to a sub-agent, use the ${BuiltInToolNames.SubAgent} tool. The sub-agent executes autonomously and returns results:`,
    exampleArgs: [
      ["description", "Fix lint errors in utils/"],
      [
        "prompt",
        "Run get_problems on all .ts files in the utils/ directory. Fix any type errors you find. Verify each fix compiles correctly.",
      ],
    ],
  },
  toolCallIcon: "UserGroupIcon",
};
