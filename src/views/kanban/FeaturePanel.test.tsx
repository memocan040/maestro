import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FeaturePanel } from "./FeaturePanel";
import type { Feature, OrchestrationSnapshot } from "@/types/bindings";

const state = vi.hoisted(() => ({
  data: null as OrchestrationSnapshot | null,
  mutate: vi.fn(),
  start: vi.fn(),
  navigate: vi.fn(),
  sessions: [] as { session_id: string; task_id: number }[],
}));
vi.mock("@/services/orchestration.service", () => ({
  useOrchestration: () => ({ data: state.data, isLoading: false, error: null }),
  useOrchestrationMutation: () => ({ mutate: state.mutate, isPending: false }),
  useStartOrchestrator: () => ({ mutate: state.start, isPending: false, error: null }),
}));
vi.mock("@/services/task.service", () => ({ useTasksQuery: () => ({ data: [] }) }));
vi.mock("@/store/navigationStore", () => ({
  useNavigate: () => state.navigate,
}));
vi.mock("@/services/execution.service", () => ({
  useActiveSessionsQuery: () => ({ data: state.sessions, isLoading: false }),
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
    state.sessions = [];
    state.data = {
      members: [],
      features: [{ ...feature }],
      messages: [],
      discussions: [],
      chat_settings: { max_consultants: 2, max_rounds: 2 },
      task_members: {},
    };
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
  it("opens the waiting plan directly from the approval entry without approving it", () => {
    render(<FeaturePanel projectId={7} />);
    fireEvent.click(screen.getByRole("button", { name: "Review pending plan (1)" }));
    expect(screen.getByText("API")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Approve plan and start workers" }),
    ).toBeInTheDocument();
    expect(state.mutate).not.toHaveBeenCalled();
    expect(state.start).not.toHaveBeenCalled();
  });
  it("makes the related plan reachable from its orchestrator task", () => {
    render(<FeaturePanel projectId={7} taskId={1} />);
    fireEvent.click(screen.getByRole("button", { name: "Review feature plan" }));
    expect(
      screen.getByRole("button", { name: "Approve plan and start workers" }),
    ).toBeInTheDocument();
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it("does not show another feature's approval for an unrelated task", () => {
    render(<FeaturePanel projectId={7} taskId={99} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
  it("opens the exact active orchestrator session instead of its task details", () => {
    state.sessions = [
      { session_id: "unrelated", task_id: 2 },
      { session_id: "lead-session", task_id: 1 },
    ];
    openFeature();
    fireEvent.click(screen.getByRole("button", { name: "Orchestrator session" }));
    expect(state.navigate).toHaveBeenCalledWith({ sessionId: "lead-session" });
    expect(state.start).not.toHaveBeenCalled();
  });
  it("explains a closed session and keeps its saved conversation accessible", () => {
    openFeature();
    fireEvent.click(screen.getByRole("button", { name: "Orchestrator session" }));
    expect(screen.getByRole("status")).toHaveTextContent("No active orchestrator session");
    expect(state.navigate).not.toHaveBeenCalled();
    expect(state.start).not.toHaveBeenCalled();
  });
});
