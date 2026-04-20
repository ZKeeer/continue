import { Tool } from "../..";
import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "../builtIn";

export const manageTodoListTool: Tool = {
  type: "function",
  displayTitle: "Manage Todo List",
  wouldLikeTo: "update the task list",
  isCurrently: "updating the task list",
  hasAlready: "updated the task list",
  readonly: true,
  group: BUILT_IN_GROUP_NAME,
  function: {
    name: BuiltInToolNames.ManageTodoList,
    description:
      "Create and manage a task list to track progress on multi-step work. Pass the complete list of items each time. Use this when working on complex tasks that benefit from visible progress tracking.",
    parameters: {
      type: "object",
      required: ["items"],
      properties: {
        items: {
          type: "array",
          description:
            "Complete array of all todo items. Must include ALL items with current status.",
          items: {
            type: "object",
            required: ["id", "title", "status"],
            properties: {
              id: {
                type: "number",
                description: "Sequential ID starting from 1",
              },
              title: {
                type: "string",
                description: "Short action-oriented description (3-7 words)",
              },
              status: {
                type: "string",
                enum: ["not-started", "in-progress", "completed"],
                description: "Current status of this item",
              },
            },
          },
        },
      },
    },
  },
  defaultToolPolicy: "allowedWithoutPermission",
  systemMessageDescription: {
    prefix: `To track progress on multi-step tasks, use the ${BuiltInToolNames.ManageTodoList} tool. Pass ALL items each time with updated status:`,
    exampleArgs: [
      [
        "items",
        '[{"id":1,"title":"Read existing code","status":"completed"},{"id":2,"title":"Implement changes","status":"in-progress"},{"id":3,"title":"Verify compilation","status":"not-started"}]',
      ],
    ],
  },
  toolCallIcon: "ClipboardDocumentListIcon",
};
