import { ToolImpl } from ".";
import { getStringArg } from "../parseArgs";

export const findReferencesImpl: ToolImpl = async (args, extras) => {
  const filepath = getStringArg(args, "filepath");
  const line = Number(args.line);
  const character = Number(args.character);

  if (isNaN(line) || isNaN(character)) {
    throw new Error("line and character must be valid numbers");
  }

  const references = await extras.ide.getReferences({
    filepath,
    position: { line, character },
  });

  if (references.length === 0) {
    return [
      {
        name: "No References",
        description: "No references found for symbol at this position",
        content: `No references found for the symbol at ${filepath}:${line}:${character}.`,
      },
    ];
  }

  const lines = references.map(
    (ref) =>
      `- ${ref.filepath}:${ref.range.start.line + 1}:${ref.range.start.character + 1}`,
  );

  const content = `Found ${references.length} reference(s):\n\n${lines.join("\n")}`;

  return [
    {
      name: "References",
      description: `${references.length} reference(s) found`,
      content,
    },
  ];
};
