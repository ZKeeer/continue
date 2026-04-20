import { useMemo, useState } from "react";
import { useAppSelector } from "../../redux/hooks";
import type { TodoItem } from "../../redux/slices/sessionSlice";

function StatusIcon({ status }: { status: TodoItem["status"] }) {
  switch (status) {
    case "completed":
      return <span className="text-green-500">✓</span>;
    case "in-progress":
      return <span className="animate-pulse text-yellow-500">⏳</span>;
    default:
      return <span className="text-description">○</span>;
  }
}

export default function TodoListWidget() {
  const todoListItems = useAppSelector((state) => state.session.todoListItems);
  const [collapsed, setCollapsed] = useState(false);

  const { total, completed, inProgress } = useMemo(() => {
    if (!todoListItems?.length)
      return { total: 0, completed: 0, inProgress: 0 };
    return {
      total: todoListItems.length,
      completed: todoListItems.filter((i) => i.status === "completed").length,
      inProgress: todoListItems.filter((i) => i.status === "in-progress")
        .length,
    };
  }, [todoListItems]);

  if (!todoListItems?.length) return null;

  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="border-border mx-2 mb-1 rounded-md border border-solid bg-transparent">
      {/* Header with progress */}
      <div
        className="flex cursor-pointer items-center gap-2 px-3 py-1.5"
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className="text-description text-xs">
          {collapsed ? "▶" : "▼"}
        </span>
        <span className="text-foreground text-xs font-medium">Tasks</span>
        <span className="text-description text-xs">
          {completed}/{total}
        </span>
        {/* Progress bar */}
        <div className="bg-border h-1.5 flex-1 rounded-full">
          <div
            className="h-full rounded-full bg-green-500 transition-all duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
        {inProgress > 0 && (
          <span className="text-xs text-yellow-500">{inProgress} active</span>
        )}
      </div>

      {/* Collapsed: hide items */}
      {!collapsed && (
        <div className="border-border border-t border-solid px-3 py-1">
          {todoListItems.map((item) => (
            <div
              key={item.id}
              className="flex items-center gap-2 py-0.5 text-xs"
            >
              <StatusIcon status={item.status} />
              <span
                className={
                  item.status === "completed"
                    ? "text-description line-through"
                    : "text-foreground"
                }
              >
                {item.title}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
