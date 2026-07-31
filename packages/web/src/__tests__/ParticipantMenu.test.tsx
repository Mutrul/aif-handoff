import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ParticipantMenu } from "@/components/participants/ParticipantMenu";

const admin = {
  id: "participant-admin",
  displayName: "Ada Lovelace",
  role: "admin" as const,
  active: true,
};

describe("ParticipantMenu", () => {
  it("shows participant administration only to administrators", () => {
    const onManageParticipants = vi.fn();
    render(
      <ParticipantMenu
        participant={admin}
        onManageParticipants={onManageParticipants}
        onLogout={vi.fn()}
        isLoggingOut={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Participant menu for Ada Lovelace" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Manage participants" }));

    expect(onManageParticipants).toHaveBeenCalledTimes(1);
  });

  it("hides participant administration from members and supports logout", () => {
    const onLogout = vi.fn().mockResolvedValue(undefined);
    render(
      <ParticipantMenu
        participant={{ ...admin, id: "participant-member", role: "member" }}
        onManageParticipants={vi.fn()}
        onLogout={onLogout}
        isLoggingOut={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Participant menu for Ada Lovelace" }));

    expect(screen.queryByRole("menuitem", { name: "Manage participants" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });
});
