import { useMemo, useRef } from "react";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { selectSelectedChatModelContextLength } from "../../redux/slices/configSlice";
import { saveCurrentSession } from "../../redux/thunks/session";
import { useCompactConversation } from "../../util/compactConversation";
import { ToolTip } from "../gui/Tooltip";

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${tokens}`;
}

const ContextStatus = () => {
  const dispatch = useAppDispatch();
  const contextPercentage = useAppSelector(
    (state) => state.session.contextPercentage,
  );
  const selectedChatModel = useAppSelector(
    (state) => state.config.config.selectedModelByRole.chat?.model,
  );
  const contextLength = useAppSelector(selectSelectedChatModelContextLength);
  const previousHistoryLength = useRef<number | null>(null);
  const previousSelectedChatModel = useRef<string | null>(null);
  const history = useAppSelector((state) => state.session.history);
  const compactConversation = useCompactConversation();
  const percent = contextPercentage !== undefined ? Math.round(contextPercentage * 100) : undefined;
  const isPruned = useAppSelector((state) => state.session.isPruned);
  const usedTokens = contextPercentage !== undefined ? Math.round(contextPercentage * contextLength) : undefined;

  const isDifferentModelAndSameHistory = useMemo(() => {
    if (!selectedChatModel) return false;
    if (previousHistoryLength.current !== history.length) {
      previousHistoryLength.current = history.length;
      previousSelectedChatModel.current = selectedChatModel;
      return false;
    }
    return previousSelectedChatModel.current !== selectedChatModel;
  }, [history.length, selectedChatModel]);

  if (!contextLength) {
    return null;
  }

  if (isDifferentModelAndSameHistory) {
    return null;
  }

  // Tiered color: when undefined (not yet calculated), show muted color
  const barColorClass =
    percent === undefined
      ? "bg-description-muted"
      : isPruned || percent >= 85
        ? "bg-error"
        : percent >= 75
          ? "bg-warning"
          : "bg-description";

  return (
    <div>
      <ToolTip
        closeEvents={{
          mouseleave: true,
          click: true,
          mouseup: false,
        }}
        clickable
        content={
          <div className="flex flex-col gap-0 text-left text-xs">
            <span className="inline-block">
              {percent !== undefined
                ? `${formatTokenCount(usedTokens!)} / ${formatTokenCount(contextLength)} tokens (${percent}%)`
                : `-- / ${formatTokenCount(contextLength)} tokens`}
            </span>
            {percent !== undefined && percent >= 75 && percent < 85 && !isPruned && (
              <span className="text-warning inline-block">
                {`Context window getting full. Consider compacting or starting a new session.`}
              </span>
            )}
            {percent !== undefined && percent >= 85 && !isPruned && (
              <span className="text-error inline-block">
                {`Context nearly full. Auto-compaction will trigger soon.`}
              </span>
            )}
            {isPruned && (
              <span className="text-error inline-block font-semibold">
                {`Oldest messages are being removed. Strongly recommend starting a new session.`}
              </span>
            )}
            {history.length > 0 && (
              <div className="flex flex-col gap-1 whitespace-pre">
                <div>
                  <span
                    className="hover:text-link inline-block cursor-pointer underline"
                    onClick={() => compactConversation(-1)}
                  >
                    Compact conversation
                  </span>
                  {"\n"}
                  <span
                    className="hover:text-link inline-block cursor-pointer underline"
                    onClick={() => {
                      void dispatch(
                        saveCurrentSession({
                          openNewSession: true,
                          generateTitle: false,
                        }),
                      );
                    }}
                  >
                    Start a new session
                  </span>
                </div>
              </div>
            )}
          </div>
        }
      >
        <div className="flex items-center gap-1">
          <span
            className={`text-[10px] leading-none ${
              percent === undefined
                ? "text-description-muted"
                : isPruned || percent >= 85
                  ? "text-error"
                  : percent >= 75
                    ? "text-warning"
                    : "text-description"
            }`}
          >
            {percent !== undefined
              ? `${formatTokenCount(usedTokens!)}/${formatTokenCount(contextLength)}`
              : `--/${formatTokenCount(contextLength)}`}
          </span>
          <div className="border-command-border relative h-[14px] w-[7px] rounded-[1px] border-[0.5px] border-solid md:h-[10px] md:w-[5px]">
            <div
              className={`transition-height absolute bottom-0 left-0 w-full duration-300 ease-in-out ${barColorClass}`}
              style={{ height: `${percent ?? 0}%` }}
            />
          </div>
        </div>
      </ToolTip>
    </div>
  );
};

export default ContextStatus;
