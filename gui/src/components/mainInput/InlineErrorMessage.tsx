import { useContext } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { setInlineErrorMessage } from "../../redux/slices/sessionSlice";

export type InlineErrorMessageType =
  | "out-of-context"
  | "max-iterations"
  | "auto-compacting"
  | {
      type: "budget-exceeded";
      elapsedMin: number;
      iterations: number;
      maxBudgetIterations: number;
      todoSummary: string;
    };

export default function InlineErrorMessage() {
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const inlineErrorMessage = useAppSelector(
    (state) => state.session.inlineErrorMessage,
  );
  if (inlineErrorMessage === "auto-compacting") {
    return (
      <div
        className={`border-border relative m-2 flex flex-col rounded-md border border-solid bg-transparent p-4`}
      >
        <p className={`thread-message text-description text-center text-xs`}>
          {`Context window getting full. Auto-compacting conversation history...`}
        </p>
      </div>
    );
  }
  if (inlineErrorMessage === "max-iterations") {
    return (
      <div
        className={`border-border relative m-2 flex flex-col rounded-md border border-solid bg-transparent p-4`}
      >
        <p className={`thread-message text-warning text-center`}>
          {`Agent reached maximum iteration limit. Please start a new session or simplify your request.`}
        </p>
        <div className="text-description flex flex-row items-center justify-center gap-1.5 px-3">
          <span
            className="cursor-pointer text-xs hover:underline"
            onClick={() => {
              dispatch(setInlineErrorMessage(undefined));
            }}
          >
            Hide
          </span>
        </div>
      </div>
    );
  }
  if (inlineErrorMessage === "out-of-context") {
    return (
      <div
        className={`border-border relative m-2 flex flex-col rounded-md border border-solid bg-transparent p-4`}
      >
        <p className={`thread-message text-error text-center`}>
          {`Message exceeds context limit.`}
        </p>
        <div className="text-description flex flex-row items-center justify-center gap-1.5 px-3">
          <div
            className="cursor-pointer text-xs hover:underline"
            onClick={() => {
              ideMessenger.post("config/openProfile", {
                profileId: undefined,
              });
            }}
          >
            <span className="xs:flex hidden">Open config</span>
            <span className="xs:hidden">Config</span>
          </div>
          |
          <span
            className="cursor-pointer text-xs hover:underline"
            onClick={() => {
              dispatch(setInlineErrorMessage(undefined));
            }}
          >
            Hide
          </span>
        </div>
      </div>
    );
  }
  if (
    inlineErrorMessage &&
    typeof inlineErrorMessage === "object" &&
    inlineErrorMessage.type === "budget-exceeded"
  ) {
    const { elapsedMin, iterations, maxBudgetIterations, todoSummary } =
      inlineErrorMessage;
    return (
      <div
        className={`border-border relative m-2 flex flex-col gap-1 rounded-md border border-solid bg-transparent p-4`}
      >
        <p className={`thread-message text-warning text-center font-semibold`}>
          Agent budget exceeded — task paused
        </p>
        <p className={`thread-message text-description text-center text-xs`}>
          {`Elapsed: ${elapsedMin} min · Iterations: ${iterations}/${maxBudgetIterations}`}
        </p>
        {todoSummary && (
          <p
            className={`thread-message text-description whitespace-pre-line text-center text-xs`}
          >
            {todoSummary}
          </p>
        )}
        <p className={`thread-message text-description text-center text-xs`}>
          Review the current state and send a follow-up message to continue.
        </p>
        <div className="text-description flex flex-row items-center justify-center gap-1.5 px-3">
          <span
            className="cursor-pointer text-xs hover:underline"
            onClick={() => dispatch(setInlineErrorMessage(undefined))}
          >
            Hide
          </span>
        </div>
      </div>
    );
  }
  return null;
}
