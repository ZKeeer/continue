import { Tool } from "../..";
import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "../builtIn";

export const findReferencesTool: Tool = {
  type: "function",
  displayTitle: "Find References",
  wouldLikeTo: "find references to symbol at {{{ filepath }}}:{{{ line }}}",
  isCurrently: "finding references to symbol at {{{ filepath }}}:{{{ line }}}",
  hasAlready: "found references to symbol at {{{ filepath }}}:{{{ line }}}",
  readonly: true,
  group: BUILT_IN_GROUP_NAME,
  function: {
    name: BuiltInToolNames.FindReferences,
    description:
      "Find all references to a symbol at a given position in a file. Returns a list of file locations where the symbol is used. Useful for understanding impact of changes, finding usages before refactoring, or navigating code.",
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
    prefix: `To find all references to a symbol, use the ${BuiltInToolNames.FindReferences} tool with a file position:`,
    exampleArgs: [
      ["filepath", "/path/to/file.ts"],
      ["line", "10"],
      ["character", "5"],
    ],
  },
  toolCallIcon: "MagnifyingGlassIcon",
};
