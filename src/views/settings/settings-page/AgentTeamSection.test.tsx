import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentTeamSection } from "./AgentTeamSection";
import type { ProfilesDocument, TeamMember } from "@/types/bindings";

const state = vi.hoisted(() => ({
  document: { profiles: [], defaults: {} } as ProfilesDocument,
  members: [] as TeamMember[],
  saveProfile: vi.fn(),
  saveMember: vi.fn(),
}));
vi.mock("@/services/project.service", () => ({
  useAgentProfilesQuery: () => ({ data: state.document }),
  useSaveAgentProfilesMutation: () => ({ mutateAsync: state.saveProfile }),
}));
vi.mock("@/services/orchestration.service", () => ({
  useOrchestration: () => ({ data: { members: state.members } }),
  useTeamProviders: () => ({
    data: [
      { id: "cursor", name: "Cursor", installed: false },
      { id: "antigravity-acp", name: "Antigravity", installed: false },
    ],
  }),
  useOrchestrationMutation: () => ({ mutateAsync: state.saveMember, mutate: state.saveMember }),
}));
vi.mock("@/services/execution.service", () => ({
  useAgentConfigQuery: () => ({ refetch: vi.fn(), isSuccess: false }),
}));
vi.mock("@/services/acp-auth.service", () => ({
  useAgentAuthInfoQuery: () => ({ refetch: vi.fn() }),
}));
vi.mock("@/store/projectStore", () => ({ useSelectedProject: () => ({ path: "/fixture" }) }));
// Capability widgets are covered by AgentProfilesSection's real-widget tests.
vi.mock("@/components/common/agent-config/AgentConfigFields", () => ({
  AgentConfigFields: () => null,
}));
function mount() {
  return render(<AgentTeamSection projectId={1} connection={{ type: "local" }} />);
}
beforeEach(() => {
  cleanup();
  state.document = { profiles: [], defaults: {} };
  state.members = [];
  state.saveProfile.mockReset().mockImplementation(async ({ document }) => {
    state.document = document;
  });
  state.saveMember.mockReset().mockImplementation(async ({ member }) => {
    state.members.push(member);
  });
});
describe("Dynamic agent team", () => {
  it("adds eight independent identities with one repeated provider and combined roles", async () => {
    const user = userEvent.setup();
    const view = mount();
    for (let i = 0; i < 8; i++) {
      await user.click(screen.getByRole("button", { name: "+ Add Agent" }));
      await user.selectOptions(screen.getByLabelText("Team provider"), "cursor");
      await user.type(screen.getByLabelText("Member name"), `Cursor ${i}`);
      if (i === 0) await user.click(screen.getByLabelText("Team role reviewer"));
      await user.click(screen.getByRole("button", { name: "Save agent" }));
      await waitFor(() => expect(state.members).toHaveLength(i + 1));
      view.rerender(<AgentTeamSection projectId={1} connection={{ type: "local" }} />);
    }
    expect(new Set(state.members.map((m) => m.id)).size).toBe(8);
    expect(new Set(state.members.map((m) => m.profile_id)).size).toBe(8);
    expect(state.document.profiles).toHaveLength(8);
    expect(state.members[0]).toMatchObject({ worker: true, reviewer: true });
    expect(state.document.profiles?.every((p) => p.agent_id === "cursor")).toBe(true);
  }, 30_000);
  it("duplicates a member into an independent profile without changing the original", async () => {
    const user = userEvent.setup();
    state.document.profiles = [
      { id: "p", name: "Original", role: "Coder", agent_id: "cursor", model: "special" },
    ];
    state.members = [
      {
        id: "m",
        profile_id: "p",
        name: "Original",
        enabled: true,
        worker: true,
        orchestrator: false,
        planner: false,
        refiner: false,
        reviewer: false,
        max_sessions: 2,
        priority: 4,
        strengths: "frontend",
      },
    ];
    mount();
    await user.click(screen.getByLabelText("Duplicate Original"));
    await user.click(screen.getByRole("button", { name: "Save agent" }));
    await waitFor(() => expect(state.members).toHaveLength(2));
    expect(state.members[1].id).not.toBe("m");
    expect(state.members[1].profile_id).not.toBe("p");
    expect(state.document.profiles?.find((p) => p.id === "p")?.model).toBe("special");
    expect(state.document.profiles?.[1].model).toBe("special");
  });
  it("allows configuring an unavailable official provider without pretending it is ready", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "+ Add Agent" }));
    await user.selectOptions(screen.getByLabelText("Team provider"), "antigravity-acp");
    expect(screen.getByRole("button", { name: "Test Connection" })).toBeDisabled();
    await user.type(screen.getByLabelText("Member name"), "Google reviewer");
    await user.click(screen.getByRole("button", { name: "Save agent" }));
    await waitFor(() => expect(state.document.profiles?.[0]?.agent_id).toBe("antigravity-acp"));
  });
});
