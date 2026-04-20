import { ToolImpl } from ".";
import { getStringArg } from "../parseArgs";

export const gotoDefinitionImpl: ToolImpl = async (args, extras) => {
  const filepath = getStringArg(args, "filepath");
  const line = Number(args.line);
  const character = Number(args.character);

  if (isNaN(line) || isNaN(character)) {
    throw new Error("line and character must be valid numbers");
  }

  const definitions = await extras.ide.gotoDefinition({
    filepath,
    position: { line, character },
  });

  if (definitions.length === 0) {
    return [
      {
        name: "No Definition",
        description: "No definition found for symbol at this position",
        content: `No definition found for the symbol at ${filepath}:${line}:${character}.`,
      },
    ];
  }

  const lines = definitions.map(
    (def) =>
      `- ${def.filepath}:${def.range.start.line + 1}:${def.range.start.character + 1} → L${def.range.start.line + 1}-L${def.range.end.line + 1}`,
  );

  const content = `Found ${definitions.length} definition(s):\n\n${lines.join("\n")}`;

  return [
    {
      name: "Definition",
      description: `${definitions.length} definition(s) found`,
      content,
    },
  ];
};
