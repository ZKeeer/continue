import { createAsyncThunk } from "@reduxjs/toolkit";
import { setContextPercentage } from "../slices/sessionSlice";
import type { ThunkApiType } from "../store";
import { constructMessages } from "../util/constructMessages";
import { getBaseSystemMessage } from "../util/getBaseSystemMessage";

export const recalculateContextPercentage = createAsyncThunk<
  void,
  void,
  ThunkApiType
>(
  "session/recalculateContextPercentage",
  async (_, { dispatch, extra, getState }) => {
    const state = getState();
    const { history } = state.session;
    if (history.length === 0) return;

    const selectedChatModel = state.config.config.selectedModelByRole.chat;
    if (!selectedChatModel) return;

    const baseSystemMessage = getBaseSystemMessage(
      state.session.mode,
      selectedChatModel,
    );

    const withoutMessageIds = history.map((item) => {
      const { id, ...messageWithoutId } = item.message;
      return { ...item, message: messageWithoutId };
    });

    const { messages } = constructMessages(
      withoutMessageIds,
      baseSystemMessage,
      state.config.config.rules,
      state.ui.ruleSettings,
    );

    try {
      const result = await extra.ideMessenger.request("llm/compileChat", {
        messages,
        options: {},
      });

      if (result.status === "success") {
        dispatch(setContextPercentage(result.content.contextPercentage));
      }
    } catch (e) {
      console.error("Error recalculating context percentage:", e);
    }
  },
);
