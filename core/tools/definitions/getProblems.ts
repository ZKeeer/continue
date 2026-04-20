import { Tool } from "../..";
import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "../builtIn";

export const getProblemsTool: Tool = {
  type: "function",
  displayTitle: "Get Problems",
  wouldLikeTo: "get diagnostics/problems{{{ filepath }}}",
  isCurrently: "getting diagnostics/problems{{{ filepath }}}",
  hasAlready: "retrieved diagnostics/problems{{{ filepath }}}",
  readonly: true,
  group: BUILT_IN_GROUP_NAME,
  function: {
    name: BuiltInToolNames.GetProblems,
    description:
      "Get compile errors, warnings, and lint diagnostics for a file or the entire workspace. Use this after editing files to verify changes compile correctly, or to understand current errors before fixing them.",
    parameters: {
      type: "object",
      required: [],
      properties: {
        filepath: {
          type: "string",
          description:
            "Optional absolute path to a specific file. If omitted, returns problems for all open files in the workspace.",
        },
      },
    },
  },
  defaultToolPolicy: "allowedWithoutPermission",
  systemMessageDescription: {
    prefix: `To check for compile errors and diagnostics, use the ${BuiltInToolNames.GetProblems} tool. For example, to check errors in a specific file:`,
    exampleArgs: [["filepath", "/path/to/file.ts"]],
  },
  toolCallIcon: "ExclamationTriangleIcon",
};
