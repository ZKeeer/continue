import { render, screen } from "@testing-library/react";
import type { ApplyState } from "core";
import { describe, expect, it, vi } from "vitest";
import { IdeMessengerContext } from "../../../../context/IdeMessenger";
import { PendingApplyStatesToolbar } from "./PendingApplyStatesToolbar";

vi.mock("../../../AcceptRejectDiffButtons", () => ({
  default: () => <div data-testid="accept-reject-buttons" />,
}));

describe("PendingApplyStatesToolbar", () => {
  it("opens the file when a pending diff file badge is clicked", async () => {
    const pendingApplyStates: ApplyState[] = [
      {
        streamId: "stream-1",
        status: "done",
        filepath: "file:///repo/src/example.ts",
        numDiffs: 1,
      },
    ];

    const post = vi.fn();

    render(
      <IdeMessengerContext.Provider value={{ post } as any}>
        <PendingApplyStatesToolbar pendingApplyStates={pendingApplyStates} />
      </IdeMessengerContext.Provider>,
    );

    screen.getByRole("button", { name: "Open example.ts" }).click();

    expect(post).toHaveBeenCalledWith("showFile", {
      filepath: "file:///repo/src/example.ts",
    });
  });
});
