import { useState } from "react";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Textarea } from "@/ui/textarea";
import { Dialog, DialogContent, DialogTitle } from "@/ui/dialog";
import {
  useOrchestration,
  useOrchestrationMutation,
  useStartOrchestrator,
} from "@/services/orchestration.service";
import { useTasksQuery } from "@/services/task.service";
import { useNavigationActions } from "@/store/navigationStore";

export function FeaturePanel({ projectId }: { projectId: number }) {
  const query = useOrchestration(projectId);
  const change = useOrchestrationMutation(projectId);
  const start = useStartOrchestrator(projectId);
  const tasks = useTasksQuery(projectId);
  const navigation = useNavigationActions();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const [orchestrator, setOrchestrator] = useState("");
  const [parallel, setParallel] = useState(2);
  const [baseBranch, setBaseBranch] = useState("main");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const run = (operation: Record<string, unknown>) => {
    setError(null);
    change.mutate(operation, { onError: (e) => setError(e.message) });
  };
  const feature = query.data?.features.find((f) => f.id === selected);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Features / New Feature
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogTitle>Project orchestration</DialogTitle>
          {(error || query.error || start.error) && (
            <p role="alert" className="text-destructive">
              {error ?? query.error?.message ?? start.error?.message}
            </p>
          )}
          {query.isLoading && <p>Loading features…</p>}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setSelected(null)}>
              New feature
            </Button>
            {query.data?.features.map((f) => (
              <Button
                variant={selected === f.id ? "default" : "outline"}
                size="sm"
                key={f.id}
                onClick={() => setSelected(f.id)}
              >
                {f.title} · {f.status}
              </Button>
            ))}
          </div>
          {!feature ? (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                change.mutate(
                  {
                    action: "create_feature",
                    title,
                    goal,
                    acceptance: acceptance.split("\n").filter((s) => s.trim()),
                    orchestrator_member: orchestrator,
                    allowed_members:
                      query.data?.members
                        .filter((m) => m.enabled && (m.worker || m.reviewer))
                        .map((m) => m.id) ?? [],
                    max_parallel: parallel,
                    base_branch: baseBranch,
                  },
                  {
                    onSuccess: (data) => {
                      setSelected(data.features[data.features.length - 1]?.id ?? null);
                      setTitle("");
                    },
                    onError: (e) => setError(e.message),
                  },
                );
              }}
            >
              <Input
                aria-label="Feature title"
                placeholder="Feature title"
                minLength={3}
                maxLength={220}
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
              <Textarea
                aria-label="Feature goal"
                placeholder="Goal and project context"
                required
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
              />
              <Textarea
                aria-label="Acceptance criteria"
                placeholder="Acceptance criteria, one per line"
                required
                value={acceptance}
                onChange={(e) => setAcceptance(e.target.value)}
              />
              <label className="block text-sm">
                Orchestrator
                <select
                  className="mt-1 w-full rounded border bg-background p-2"
                  required
                  value={orchestrator}
                  onChange={(e) => setOrchestrator(e.target.value)}
                >
                  <option value="">Choose team member</option>
                  {query.data?.members
                    .filter((m) => m.enabled && m.orchestrator)
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                </select>
              </label>
              <div className="flex gap-3">
                <label className="text-sm">
                  Parallel workers
                  <Input
                    type="number"
                    min={1}
                    max={16}
                    value={parallel}
                    onChange={(e) => setParallel(Number(e.target.value))}
                  />
                </label>
                <label className="text-sm">
                  Base branch
                  <Input
                    required
                    value={baseBranch}
                    onChange={(e) => setBaseBranch(e.target.value)}
                  />
                </label>
              </div>
              <p className="text-xs text-muted-foreground">
                Plan approval and every worker integration require your approval. Configure the team
                in Project Settings → Agents.
              </p>
              <Button disabled={change.isPending} type="submit">
                Create feature
              </Button>
            </form>
          ) : (
            <div className="space-y-4">
              <h3 className="font-semibold">
                {feature.title} · {feature.status}
              </h3>
              <p className="whitespace-pre-wrap text-sm">{feature.goal}</p>
              <ul className="list-disc pl-5 text-sm">
                {feature.acceptance.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
              <div className="flex flex-wrap gap-2">
                {feature.status === "Planning" && (
                  <Button
                    disabled={
                      start.isPending ||
                      tasks.data?.some(
                        (t) => t.id === feature.orchestrator_task && t.phase_status === "Running",
                      )
                    }
                    onClick={() => start.mutate(feature.orchestrator_task)}
                  >
                    Start planning
                  </Button>
                )}
                {feature.status === "AwaitingApproval" && (
                  <Button
                    disabled={change.isPending}
                    onClick={() => run({ action: "approve_plan", feature_id: feature.id })}
                  >
                    Approve plan and start workers
                  </Button>
                )}
                {(["pause", "resume", "cancel", "complete"] as const)
                  .filter((c) =>
                    c === "pause"
                      ? feature.status === "Running"
                      : c === "resume"
                        ? ["Paused", "Blocked"].includes(feature.status)
                        : c === "complete"
                          ? feature.status === "Running"
                          : !["Completed", "Cancelled"].includes(feature.status),
                  )
                  .map((command) => (
                    <Button
                      key={command}
                      variant="outline"
                      size="sm"
                      disabled={change.isPending}
                      onClick={() => run({ action: "control", feature_id: feature.id, command })}
                    >
                      {command}
                    </Button>
                  ))}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigation.setActiveTaskId(feature.orchestrator_task)}
                >
                  Orchestrator session
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">
                {
                  feature.task_ids.filter((id) =>
                    tasks.data?.some((t) => t.id === id && t.status === "Done"),
                  ).length
                }
                /{feature.task_ids.length} tasks completed · Integration branch:{" "}
                {feature.integration_branch}
              </p>
              {feature.plan.map((t) => (
                <div key={t.key} className="rounded border p-3 text-sm">
                  <strong>{t.title}</strong>
                  <p>
                    {query.data?.members.find((m) => m.id === t.member_id)?.name} · Prerequisites:{" "}
                    {t.depends_on?.join(", ") || "none"}
                  </p>
                  <p>{t.acceptance.join(" · ")}</p>
                </div>
              ))}
              {feature.task_ids.map((id) => {
                const t = tasks.data?.find((t) => t.id === id);
                return (
                  <Button
                    key={id}
                    variant="outline"
                    size="sm"
                    onClick={() => navigation.setActiveTaskId(id)}
                  >
                    #{id} {t?.title} · {t?.status} {t?.phase_status}
                  </Button>
                );
              })}
              <div className="space-y-2">
                {query.data?.messages
                  .filter((m) => m.feature_id === feature.id)
                  .map((m) => (
                    <div key={m.id} className="rounded border p-2 text-sm">
                      <span className="text-muted-foreground">
                        {m.sender_task === null ? "You" : `Task #${m.sender_task}`} → #
                        {m.recipient_task} · {m.kind} · {m.state}
                      </span>
                      <p className="whitespace-pre-wrap">{m.body}</p>
                      {m.state === "Submitted" && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={change.isPending}
                          onClick={() => run({ action: "retry_message", message_id: m.id })}
                        >
                          Retry delivery (may repeat provider work)
                        </Button>
                      )}
                    </div>
                  ))}
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  run({
                    action: "message",
                    feature_id: feature.id,
                    recipient_task: null,
                    kind: "instruction",
                    body: message,
                    dedupe_key: crypto.randomUUID(),
                  });
                  setMessage("");
                }}
                className="space-y-2"
              >
                <Textarea
                  aria-label="Message to orchestrator"
                  required
                  placeholder="Decision or concrete follow-up for the orchestrator"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                />
                <Button type="submit" disabled={change.isPending || !message.trim()}>
                  Send to orchestrator
                </Button>
              </form>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
