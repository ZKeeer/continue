import { Tool } from "../..";
import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "../builtIn";

export const gotoDefinitionTool: Tool = {
  type: "function",
  displayTitle: "Go to Definition",
  wouldLikeTo: "go to definition of symbol at {{{ filepath }}}:{{{ line }}}",
  isCurrently: "finding definition of symbol at {{{ filepath }}}:{{{ line }}}",
  hasAlready: "found definition of symbol at {{{ filepath }}}:{{{ line }}}",
  readonly: true,
  group: BUILT_IN_GROUP_NAME,
  function: {
    name: BuiltInToolNames.GotoDefinition,
    description:
      "Navigate to the definition of a symbol at a given position in a file. Returns the file location(s) where the symbol is defined. Useful for understanding what a function/class/variable is and where it comes from.",
    parameters: {
      type: "object",
      required: ["filepath", "line", "character"],
      properties: {
        filepath: {
          type: "string",
          description: "Absolute path to the file containing the symbol",
        },
        line: {
          type: "number",
          description: "0-based line number of the symbol",
        },
        character: {
          type: "number",
          description: "0-based character offset of the symbol on the line",
        },
      },
    },
  },
  defaultToolPolicy: "allowedWithoutPermission",
  systemMessageDescription: {
    prefix: `To find the definition of a symbol, use the ${BuiltInToolNames.GotoDefinition} tool with a file position:`,
    exampleArgs: [
      ["filepath", "/path/to/file.ts"],
      ["line", "10"],
      ["character", "5"],
    ],
  },
  toolCallIcon: "ArrowTopRightOnSquareIcon",
};
