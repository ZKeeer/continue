import { useContext } from "react";
import { IdeMessengerContext } from "../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../redux/hooks";
import {
  deleteCompaction,
  setCompactionLoading,
} from "../redux/slices/sessionSlice";
import { recalculateContextPercentage } from "../redux/thunks/recalculateContextPercentage";
import { loadSession, saveCurrentSession } from "../redux/thunks/session";

export const useCompactConversation = () => {
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const currentSessionId = useAppSelector((state) => state.session.id);
  const history = useAppSelector((state) => state.session.history);

  const findCompactTarget = (preferredIndex: number): number => {
    if (preferredIndex >= 0) return preferredIndex;
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i].message;
      if (
        msg.role !== "assistant" ||
        (typeof msg.content === "string" && msg.content.trim().length > 0)
      ) {
        return i;
      }
    }
    return history.length - 1;
  };

  return async (index: number) => {
    if (!currentSessionId) {
      return;
    }

    const actualIndex = findCompactTarget(index);

    try {
      dispatch(setCompactionLoading({ index: actualIndex, loading: true }));

      await ideMessenger.request("conversation/compact", {
        index: actualIndex,
        sessionId: currentSessionId,
      });

      await dispatch(
        loadSession({
          sessionId: currentSessionId,
          saveCurrentSession: false,
        }),
      );

      await dispatch(recalculateContextPercentage());
    } catch (error) {
      console.error("Error compacting conversation:", error);
    } finally {
      dispatch(setCompactionLoading({ index: actualIndex, loading: false }));
    }
  };
};

export const useDeleteCompaction = () => {
  const dispatch = useAppDispatch();

  return (index: number) => {
    // Update local state and save to persistence
    dispatch(deleteCompaction(index));
    void dispatch(
      saveCurrentSession({
        openNewSession: false,
        generateTitle: false,
      }),
    );
  };
};
