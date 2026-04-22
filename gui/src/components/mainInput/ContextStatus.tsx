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
  const percent = Math.round((contextPercentage ?? 0) * 100);
  const isPruned = useAppSelector((state) => state.session.isPruned);
  const usedTokens = Math.round((contextPercentage ?? 0) * contextLength);

  const isDifferentModelAndSameHistory = useMemo(() => {
    if (!selectedChatModel) return false;
    // only reset if history changes
    if (previousHistoryLength.current !== history.length) {
      previousHistoryLength.current = history.length;
      previousSelectedChatModel.current = selectedChatModel;
      return false;
    }
    return previousSelectedChatModel.current !== selectedChatModel;
  }, [history.length, selectedChatModel]);

  const compactConversation = useCompactConversation();
  if (!contextLength) {
    return null;
  }

  // if user changed to a different model, we shouldn't show the context status until the user sends a new message
  if (isDifferentModelAndSameHistory) {
    return null;
  }

  // Tiered color: 60-75% normal, 75-85% warning, 85%+ or pruned = error
  const barColorClass =
    isPruned || percent >= 85
      ? "bg-error"
      : percent >= 75
        ? "bg-warning"
        : "bg-description";

  return (
    <div>
      <ToolTip
        closeEvents={{
          // blur: false,
          mouseleave: true,
          click: true,
          mouseup: false,
        }}
        clickable
        content={
          <div className="flex flex-col gap-0 text-left text-xs">
            <span className="inline-block">
              {`${formatTokenCount(usedTokens)} / ${formatTokenCount(contextLength)} tokens (${percent}%)`}
            </span>
            {percent >= 75 && percent < 85 && !isPruned && (
              <span className="text-warning inline-block">
                {`Context window getting full. Consider compacting or starting a new session.`}
              </span>
            )}
            {percent >= 85 && !isPruned && (
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
                    onClick={() => compactConversation(history.length - 1)}
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
              isPruned || percent >= 85
                ? "text-error"
                : percent >= 75
                  ? "text-warning"
                  : "text-description"
            }`}
          >
            {formatTokenCount(usedTokens)}/{formatTokenCount(contextLength)}
          </span>
          <div className="border-command-border relative h-[14px] w-[7px] rounded-[1px] border-[0.5px] border-solid md:h-[10px] md:w-[5px]">
            <div
              className={`transition-height absolute bottom-0 left-0 w-full duration-300 ease-in-out ${barColorClass}`}
              style={{ height: `${percent}%` }}
            />
          </div>
        </div>
      </ToolTip>
    </div>
  );
};

export default ContextStatus;
