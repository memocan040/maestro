import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FeaturePanel } from "./FeaturePanel";
import type { Feature, OrchestrationSnapshot } from "@/types/bindings";

const state = vi.hoisted(() => ({
  data: null as OrchestrationSnapshot | null,
  mutate: vi.fn(),
  start: vi.fn(),
}));
vi.mock("@/services/orchestration.service", () => ({
  useOrchestration: () => ({ data: state.data, isLoading: false, error: null }),
  useOrchestrationMutation: () => ({ mutate: state.mutate, isPending: false }),
  useStartOrchestrator: () => ({ mutate: state.start, isPending: false, error: null }),
}));
vi.mock("@/services/task.service", () => ({ useTasksQuery: () => ({ data: [] }) }));
vi.mock("@/store/navigationStore", () => ({
  useNavigationActions: () => ({ setActiveTaskId: vi.fn() }),
}));
const feature: Feature = {
  id: "f",
  title: "Build account flow",
  goal: "Create accounts",
  acceptance: ["Tests pass"],
  orchestrator_member: "lead",
  orchestrator_task: 1,
  allowed_members: ["worker"],
  max_parallel: 2,
  base_branch: "main",
  integration_branch: "codex/feature-f",
  status: "AwaitingApproval",
  plan: [
    {
      key: "a",
      title: "API",
      instructions: "Implement API",
      acceptance: ["Tests pass"],
      member_id: "worker",
      depends_on: [],
    },
  ],
  task_ids: [],
  created_at: "2026-10-09T00:00:00Z",
};
function openFeature() {
  render(<FeaturePanel projectId={7} />);
  fireEvent.click(screen.getByText("Features / New Feature"));
  fireEvent.click(
    screen.getByRole("button", { name: `${feature.title} · ${state.data?.features[0].status}` }),
  );
}
describe("FeaturePanel approval boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.data = { members: [], features: [{ ...feature }], messages: [] };
  });
  it("displays the proposed plan without starting workers until the user approves", () => {
    openFeature();
    expect(screen.getByText("API")).toBeInTheDocument();
    expect(state.mutate).not.toHaveBeenCalled();
    expect(state.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Approve plan and start workers"));
    expect(state.mutate).toHaveBeenCalledWith(
      { action: "approve_plan", feature_id: "f" },
      expect.any(Object),
    );
  });
  it("does not offer execution or plan approval for a cancelled feature", () => {
    state.data!.features[0].status = "Cancelled";
    openFeature();
    expect(screen.queryByText("Start planning")).not.toBeInTheDocument();
    expect(screen.queryByText("Approve plan and start workers")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "resume" })).not.toBeInTheDocument();
    expect(state.start).not.toHaveBeenCalled();
  });
});
