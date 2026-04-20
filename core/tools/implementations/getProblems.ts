import { ToolImpl } from ".";
import { getStringArg } from "../parseArgs";

export const getProblemsImpl: ToolImpl = async (args, extras) => {
  const filepath = getStringArg(args, "filepath", false);

  const problems = await extras.ide.getProblems(filepath || undefined);

  if (problems.length === 0) {
    const scope = filepath ? `in ${filepath}` : "in the workspace";
    return [
      {
        name: "No Problems",
        description: `No diagnostics found ${scope}`,
        content: `No errors, warnings, or diagnostics found ${scope}.`,
      },
    ];
  }

  // Group problems by file
  const grouped = new Map<string, typeof problems>();
  for (const problem of problems) {
    const key = problem.filepath;
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key)!.push(problem);
  }

  const lines: string[] = [];
  for (const [file, fileProblems] of grouped) {
    lines.push(`## ${file}`);
    for (const p of fileProblems) {
      const loc = `Line ${p.range.start.line + 1}`;
      lines.push(`- ${loc}: ${p.message}`);
    }
    lines.push("");
  }

  const summary = `Found ${problems.length} problem(s) in ${grouped.size} file(s)`;

  return [
    {
      name: "Problems",
      description: summary,
      content: `${summary}\n\n${lines.join("\n")}`,
    },
  ];
};
