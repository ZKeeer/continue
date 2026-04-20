import { ToolImpl } from ".";

interface TodoItem {
  id: number;
  title: string;
  status: "not-started" | "in-progress" | "completed";
}

export const manageTodoListImpl: ToolImpl = async (args, _extras) => {
  const items = (args.items || []) as TodoItem[];

  if (items.length === 0) {
    return [
      {
        name: "Todo List",
        description: "Empty list",
        content: "No items in the todo list.",
      },
    ];
  }

  const total = items.length;
  const completed = items.filter((i) => i.status === "completed").length;
  const inProgress = items.filter((i) => i.status === "in-progress").length;

  const lines = items.map((item) => {
    const checkbox = item.status === "completed" ? "[x]" : "[ ]";
    const marker = item.status === "in-progress" ? " ⏳" : "";
    return `- ${checkbox} ${item.title}${marker}`;
  });

  const progress = `Progress: ${completed}/${total} completed${inProgress > 0 ? `, ${inProgress} in progress` : ""}`;
  const content = `${progress}\n\n${lines.join("\n")}`;

  return [
    {
      name: "Todo List",
      description: progress,
      content,
    },
  ];
};
