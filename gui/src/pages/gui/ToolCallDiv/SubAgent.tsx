import {
  CheckIcon,
  UserGroupIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { ToolCallState } from "core";
import { useState } from "react";
import Spinner from "../../../components/gui/Spinner";
import StyledMarkdownPreview from "../../../components/StyledMarkdownPreview";
import { ToolTruncateHistoryIcon } from "./ToolTruncateHistoryIcon";

interface SubAgentDisplayProps {
  toolCallState: ToolCallState;
  historyIndex: number;
}

export function SubAgentDisplay({
  toolCallState,
  historyIndex,
}: SubAgentDisplayProps) {
  const [open, setOpen] = useState(false);

  const args = toolCallState.parsedArgs;
  const output = toolCallState.output?.[0];
  const status = toolCallState.status;

  const description: string = (args?.description as string) ?? "Sub-Agent";
  const isRunning = status === "calling";
  const isDone = status === "done";
  const isError =
    output?.name === "Sub-Agent Error" ||
    output?.name === "Sub-Agent Incomplete" ||
    status === "errored";

  // Progress text injected by onPartialOutput, e.g. "Running: Explore auth (3/15)"
  const progressText = isRunning
    ? (output?.description ?? `Running: ${description}`)
    : null;
  // Tool-call detail lines injected by onPartialOutput, e.g. "readFile(filepath=src/foo.ts)"
  const progressDetail = isRunning ? (output?.content ?? null) : null;

  const resultContent = isDone ? (output?.content ?? null) : null;

  function renderStatusIcon() {
    if (isRunning) return <Spinner />;
    if (isDone && !isError)
      return <CheckIcon className="h-4 w-4 text-green-500" />;
    if (isError) return <XMarkIcon className="h-4 w-4 text-red-500" />;
    return <UserGroupIcon className="h-4 w-4" />;
  }

  function statusLabel(): string {
    if (isRunning) return progressText ?? `Running: ${description}`;
    if (isDone && isError) return `Failed: ${description}`;
    if (isDone) return `Completed: ${description}`;
    return `Continue wants to run sub-agent: ${description}`;
  }

  return (
    <div className="mt-1 flex flex-col px-4">
      {/* Header row */}
      <div className="flex flex-row items-center justify-between gap-2">
        <div
          className={`text-description flex min-w-0 flex-row items-center gap-1.5 text-xs transition-colors duration-200 ease-in-out ${
            isDone && resultContent ? "cursor-pointer hover:brightness-125" : ""
          }`}
          onClick={
            isDone && resultContent ? () => setOpen((o) => !o) : undefined
          }
          data-testid="sub-agent-status"
        >
          <div className="h-4 w-4 flex-shrink-0">{renderStatusIcon()}</div>
          <span className="min-w-0 truncate">{statusLabel()}</span>
          {isDone && resultContent && (
            <span className="text-description ml-1 opacity-60">
              {open ? "▲" : "▼"}
            </span>
          )}
        </div>
        {isDone && <ToolTruncateHistoryIcon historyIndex={historyIndex} />}
      </div>

      {/* Live tool-call detail: shown while sub-agent is running */}
      {isRunning && progressDetail && (
        <div className="text-description mt-1 max-h-24 overflow-y-auto font-mono text-xs opacity-75">
          {progressDetail.split("\n").map((line, i) => (
            <div key={i} className="truncate">
              {line}
            </div>
          ))}
        </div>
      )}

      {/* Collapsible result */}
      {isDone && open && resultContent && (
        <div
          className={`mt-2 max-h-[50vh] overflow-y-auto transition-all duration-300 ease-in-out`}
        >
          <StyledMarkdownPreview
            isRenderingInStepContainer
            disableManualApply
            source={resultContent}
            itemIndex={historyIndex}
          />
        </div>
      )}
    </div>
  );
}
