import { ToolImpl } from ".";
import { getStringArg } from "../parseArgs";

export const renameSymbolImpl: ToolImpl = async (args, extras) => {
  const filepath = getStringArg(args, "filepath");
  const line = Number(args.line);
  const character = Number(args.character);
  const newName = getStringArg(args, "newName");

  if (isNaN(line) || isNaN(character)) {
    throw new Error("line and character must be valid numbers");
  }

  if (!newName || newName.trim().length === 0) {
    throw new Error("newName must be a non-empty string");
  }

  const result = await extras.ide.renameSymbol({
    filepath,
    position: { line, character },
    newName,
  });

  if (!result.success) {
    throw new Error(
      result.error ||
        "Rename failed. The language server may not support rename at this position.",
    );
  }

  const filesChanged = result.filesChanged || 0;
  const content = `Successfully renamed symbol to "${newName}".\nModified ${filesChanged} file(s).`;

  return [
    {
      name: "Rename Complete",
      description: `Renamed to "${newName}" in ${filesChanged} file(s)`,
      content,
    },
  ];
};
