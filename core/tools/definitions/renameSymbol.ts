import { Tool } from "../..";
import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "../builtIn";

export const renameSymbolTool: Tool = {
  type: "function",
  displayTitle: "Rename Symbol",
  wouldLikeTo:
    'rename symbol "{{{ newName }}}" at {{{ filepath }}}:{{{ line }}}',
  isCurrently:
    'renaming symbol to "{{{ newName }}}" at {{{ filepath }}}:{{{ line }}}',
  hasAlready:
    'renamed symbol to "{{{ newName }}}" at {{{ filepath }}}:{{{ line }}}',
  readonly: false,
  group: BUILT_IN_GROUP_NAME,
  function: {
    name: BuiltInToolNames.RenameSymbol,
    description:
      "Rename a symbol across the entire workspace using the language server. This performs a semantics-aware rename that updates all references, imports, and usages. Much more reliable than find-and-replace for code symbols.",
    parameters: {
      type: "object",
      required: ["filepath", "line", "character", "newName"],
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
        newName: {
          type: "string",
          description: "The new name for the symbol",
        },
      },
    },
  },
  defaultToolPolicy: "allowedWithPermission",
  systemMessageDescription: {
    prefix: `To rename a symbol across the workspace (using LSP), use the ${BuiltInToolNames.RenameSymbol} tool:`,
    exampleArgs: [
      ["filepath", "/path/to/file.ts"],
      ["line", "10"],
      ["character", "5"],
      ["newName", "newFunctionName"],
    ],
  },
  toolCallIcon: "PencilSquareIcon",
};
