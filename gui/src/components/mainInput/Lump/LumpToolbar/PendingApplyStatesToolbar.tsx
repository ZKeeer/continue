import { ApplyState } from "core";
import { getUriPathBasename } from "core/util/uri";
import { useContext } from "react";
import { IdeMessengerContext } from "../../../../context/IdeMessenger";
import AcceptRejectDiffButtons from "../../../AcceptRejectDiffButtons";
import FileIcon from "../../../FileIcon";

interface PendingApplyStatesToolbarProps {
  pendingApplyStates: ApplyState[];
}

export function PendingApplyStatesToolbar({
  pendingApplyStates,
}: PendingApplyStatesToolbarProps) {
  const ideMessenger = useContext(IdeMessengerContext);

  // Group apply states by filepath
  const applyStatesByFilepath = pendingApplyStates.reduce(
    (acc, state) => {
      const filepath = state.filepath || ""; // Use empty string as fallback
      if (!acc[filepath]) {
        acc[filepath] = [];
      }
      acc[filepath].push(state);
      return acc;
    },
    {} as Record<string, ApplyState[]>,
  );

  return (
    <div className="flex flex-col gap-2">
      {Object.entries(applyStatesByFilepath).map(([filepath, states]) => (
        <div key={filepath} className="flex justify-between gap-3">
          {filepath && (
            <button
              aria-label={`Open ${getUriPathBasename(filepath)}`}
              className="bg-badge text-description-muted flex min-w-0 max-w-[75%] cursor-pointer items-center gap-1 truncate rounded border-none p-0 pr-1 text-xs hover:brightness-125 focus:outline-none focus:ring-1 focus:ring-current"
              onClick={() => {
                ideMessenger.post("showFile", { filepath });
              }}
              type="button"
            >
              <FileIcon filename={filepath} height="18px" width="18px" />
              <span className="truncate">{getUriPathBasename(filepath)}</span>
            </button>
          )}
          <AcceptRejectDiffButtons
            applyStates={states}
            onAcceptOrReject={async () => {}}
          />
        </div>
      ))}
    </div>
  );
}
