import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TeamChat } from "./TeamChat";
import type { Feature, OrchestrationSnapshot, Task } from "@/types/bindings";
const state = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock("@/services/orchestration.service", () => ({
  useOrchestrationMutation: () => ({ mutate: state.mutate, isPending: false }),
}));
const feature: Feature = {
  id: "f",
  title: "API",
  goal: "Design API",
  acceptance: ["Tests"],
  orchestrator_member: "lead",
  orchestrator_task: 1,
  allowed_members: ["worker"],
  max_parallel: 2,
  base_branch: "main",
  integration_branch: "codex/f",
  status: "Running",
  plan: [],
  task_ids: [2],
  created_at: "2026-10-10T00:00:00Z",
};
function snapshot(): OrchestrationSnapshot {
  return {
    features: [feature],
    members: [
      {
        id: "lead",
        profile_id: "lead-p",
        name: "Lead",
        strengths: "",
        enabled: true,
        orchestrator: true,
        planner: true,
        refiner: false,
        worker: false,
        reviewer: false,
        max_sessions: 1,
        priority: 0,
      },
      {
        id: "worker",
        profile_id: "w-p",
        name: "Cursor worker",
        strengths: "",
        enabled: true,
        orchestrator: false,
        planner: false,
        refiner: false,
        worker: true,
        reviewer: false,
        max_sessions: 1,
        priority: 0,
      },
    ],
    task_members: { 1: "lead", 2: "worker" },
    discussions: [],
    chat_settings: { max_consultants: 2, max_rounds: 2 },
    messages: [
      {
        id: "m",
        feature_id: "f",
        sender_task: 2,
        recipient_task: 1,
        kind: "question",
        body: "Support negatives?",
        state: "Pending",
        created_at: "2026-10-10T00:00:00Z",
        sender_name: "Cursor worker",
        sender_agent: "cursor",
        sender_role: "Worker",
      },
    ],
  };
}
function mount(data = snapshot()) {
  return render(
    <TeamChat
      projectId={7}
      feature={feature}
      snapshot={data}
      tasks={[
        {
          id: 2,
          title: "Implementation",
          status: "InProgress",
          agent_id: "cursor",
          phase_status: "Running",
        } as Task,
      ]}
      openTask={vi.fn()}
    />,
  );
}
beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe("Team Chat", () => {
  it("shows and filters stored activity without any mutation or provider start", () => {
    mount();
    expect(screen.getByText("Support negatives?")).toBeInTheDocument();
    expect(screen.getAllByText("Cursor worker").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /^Discussion$/ }));
    fireEvent.change(screen.getByLabelText("Chat filter"), { target: { value: "answer" } });
    expect(screen.queryByText("Support negatives?")).not.toBeInTheDocument();
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it("sends to the orchestrator by default and preserves approvals", () => {
    mount();
    fireEvent.change(screen.getByLabelText("Team chat message"), {
      target: { value: "Use API v2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(state.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "message",
        feature_id: "f",
        recipient_task: null,
        kind: "question",
        body: "Use API v2",
      }),
      expect.any(Object),
    );
    expect(state.mutate.mock.calls[0][0].action).not.toBe("approve_plan");
  });
  it("routes a team message only to the orchestrator", () => {
    mount();
    fireEvent.change(screen.getByLabelText("Chat recipient"), { target: { value: "team" } });
    fireEvent.change(screen.getByLabelText("Team chat message"), {
      target: { value: "Clarify interface" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(state.mutate).toHaveBeenCalledTimes(1);
    expect(state.mutate.mock.calls[0][0]).toMatchObject({
      recipient_task: null,
      kind: "team_instruction",
    });
  });
  it("replies directly to the exact worker task", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Reply to sender" }));
    fireEvent.change(screen.getByLabelText("Team chat message"), { target: { value: "Yes" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(state.mutate.mock.calls[0][0]).toMatchObject({
      recipient_task: 2,
      kind: "answer",
      body: "Yes",
    });
  });
  it("requires an explicit retry for uncertain delivery", () => {
    const data = snapshot();
    data.messages[0].state = "Submitted";
    mount(data);
    expect(state.mutate).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Retry delivery (may repeat provider work)" }),
    );
    expect(state.mutate.mock.calls[0][0]).toEqual({ action: "retry_message", message_id: "m" });
  });
  it("opening discussion controls starts no consultant", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Start discussion" }));
    expect(screen.getByText(/At most 2 additional agents and 2 rounds/)).toBeInTheDocument();
    expect(state.mutate).not.toHaveBeenCalled();
  });
});
