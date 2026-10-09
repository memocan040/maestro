import { useState } from "react";
import { MessageCircle, Activity, Users, User } from "lucide-react";
import { Button } from "@/ui/button";
import { Textarea } from "@/ui/textarea";
import { Input } from "@/ui/input";
import { useOrchestrationMutation } from "@/services/orchestration.service";
import type { Feature, OrchestrationSnapshot, Task } from "@/types/bindings";

export function TeamChat({
  projectId,
  feature,
  snapshot,
  tasks,
  openTask,
}: {
  projectId: number;
  feature: Feature;
  snapshot: OrchestrationSnapshot;
  tasks: Task[];
  openTask: (id: number) => void;
}) {
  const change = useOrchestrationMutation(projectId);
  const settings = snapshot.chat_settings ?? { max_consultants: 2, max_rounds: 2 };
  const [view, setView] = useState<"activity" | "discussion">("activity");
  const [filter, setFilter] = useState("all");
  const [recipient, setRecipient] = useState("orchestrator");
  const [kind, setKind] = useState("question");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [goal, setGoal] = useState("");
  const [participants, setParticipants] = useState<string[]>([]);
  const [meeting, setMeeting] = useState(false);
  const [followUp, setFollowUp] = useState("");
  const [summary, setSummary] = useState("");
  const [limitAgents, setLimitAgents] = useState(settings.max_consultants);
  const [limitRounds, setLimitRounds] = useState(settings.max_rounds);
  const closed = ["Completed", "Cancelled"].includes(feature.status);
  const members = snapshot.members.filter(
    (m) => feature.allowed_members.includes(m.id) || m.id === feature.orchestrator_member,
  );
  const discussions = (snapshot.discussions ?? []).filter((d) => d.feature_id === feature.id);
  const featureTasks = [...feature.task_ids, ...discussions.flatMap((d) => d.task_ids)];
  const workerTask = (id: string) =>
    featureTasks.find(
      (task) =>
        (snapshot.task_members ?? {})[task] === id &&
        tasks.find((t) => t.id === task)?.status !== "Done",
    );
  const sender = (task: number | null) =>
    task === null
      ? null
      : task === feature.orchestrator_task
        ? members.find((m) => m.id === feature.orchestrator_member)
        : members.find((m) => (snapshot.task_members ?? {})[task] === m.id);
  const send = (operation: Record<string, unknown>, success?: () => void) => {
    setError(null);
    change.mutate(operation, { onSuccess: success, onError: (e) => setError(e.message) });
  };
  const messages = snapshot.messages.filter(
    (m) =>
      m.feature_id === feature.id &&
      (view === "activity" || !["progress", "note"].includes(m.kind)) &&
      (filter === "all" || m.kind === filter),
  );
  return (
    <section className="rounded-lg border bg-card p-4 space-y-4" aria-label="Team Chat">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold flex items-center gap-2">
          <MessageCircle className="size-4" />
          Team Chat
        </h2>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setView("discussion");
            setRecipient("orchestrator");
          }}
        >
          Chat with Orchestrator
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={view === "activity" ? "default" : "outline"}
          onClick={() => setView("activity")}
        >
          <Activity className="size-4" />
          Activity
        </Button>
        <Button
          size="sm"
          variant={view === "discussion" ? "default" : "outline"}
          onClick={() => setView("discussion")}
        >
          <Users className="size-4" />
          Discussion
        </Button>
        <select
          aria-label="Chat filter"
          className="rounded border bg-background p-1 text-sm"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          {[
            "all",
            "question",
            "answer",
            "decision",
            "blocked",
            "review_feedback",
            "progress",
            "instruction",
          ].map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </div>
      <p className="text-xs text-muted-foreground">
        {view === "activity"
          ? "Stored activity only. Viewing or filtering starts no agents."
          : "Only the addressed session receives your message. Team messages are coordinated by the orchestrator."}
      </p>
      <div className="flex flex-wrap gap-2 text-xs">
        {[
          feature.orchestrator_task,
          ...feature.task_ids,
          ...discussions.flatMap((d) => d.task_ids),
        ].map((id) => {
          const task = tasks.find((t) => t.id === id);
          return (
            <button className="rounded border px-2 py-1" key={id} onClick={() => openTask(id)}>
              #{id} {task?.title ?? "Orchestrator"} · {task?.phase_status ?? "Waiting"}
            </button>
          );
        })}
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div
        className="max-h-[45vh] overflow-y-auto space-y-3"
        aria-label="Chat messages"
        aria-live="polite"
      >
        {messages.length === 0 && (
          <p className="text-sm text-muted-foreground">No messages in this view yet.</p>
        )}
        {messages.map((m) => {
          const member = sender(m.sender_task);
          const task = tasks.find((t) => t.id === m.sender_task);
          const system = m.sender_role === "System";
          return (
            <article
              key={m.id}
              className={`rounded-lg border p-3 text-sm ${system ? "bg-muted/30" : "bg-background"}`}
            >
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="flex size-6 items-center justify-center rounded-full border">
                  {system ? (
                    <Activity className="size-3" />
                  ) : m.sender_task === null ? (
                    <User className="size-3" />
                  ) : (
                    <Users className="size-3" />
                  )}
                </span>
                <strong className="text-foreground">
                  {system
                    ? "System"
                    : (m.sender_name ??
                      (m.sender_task === null
                        ? "You"
                        : (member?.name ?? `Task #${m.sender_task}`)))}
                </strong>
                {m.sender_task !== null && !system && (
                  <span>
                    {m.sender_agent ?? task?.agent_id ?? "Provider not recorded"} ·{" "}
                    {m.sender_role ??
                      (m.sender_task === feature.orchestrator_task ? "Orchestrator" : "Worker")}
                  </span>
                )}
                <time dateTime={m.created_at}>{new Date(m.created_at).toLocaleString()}</time>
                <span>
                  {m.kind} · {m.state}
                </span>
                {m.sender_task !== null && (
                  <button className="underline" onClick={() => openTask(m.sender_task!)}>
                    Task #{m.sender_task}
                  </button>
                )}
                <button className="underline" onClick={() => openTask(m.recipient_task)}>
                  → #{m.recipient_task}
                </button>
              </div>
              <p className="whitespace-pre-wrap mt-2 break-words">{m.body}</p>
              {["question", "blocked"].includes(m.kind) && !closed && (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  onClick={() => {
                    setRecipient(
                      m.sender_task === feature.orchestrator_task
                        ? "orchestrator"
                        : `task:${m.sender_task}`,
                    );
                    setKind("answer");
                    setView("discussion");
                  }}
                >
                  Reply to sender
                </Button>
              )}
              {m.state === "Pending" && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Buffered until the recipient has a suitable idle session. Busy or offline sessions
                  do not discard this message.
                </p>
              )}
              {m.state === "Submitted" && (
                <div className="mt-2 space-y-1">
                  <p className="text-xs">
                    Handed to ACP; processing is unconfirmed. Retry can repeat paid work.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={change.isPending || closed}
                    onClick={() => send({ action: "retry_message", message_id: m.id })}
                  >
                    Retry delivery (may repeat provider work)
                  </Button>
                </div>
              )}
            </article>
          );
        })}
      </div>
      {!closed && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            const target = recipient.startsWith("member:")
              ? workerTask(recipient.slice(7))
              : recipient.startsWith("task:")
                ? Number(recipient.slice(5))
                : null;
            if (recipient.startsWith("member:") && !target) {
              setError(
                "This member has no feature task/session. Start a targeted discussion to consult it.",
              );
              return;
            }
            send(
              {
                action: "message",
                feature_id: feature.id,
                recipient_task: target ?? null,
                kind: recipient === "team" ? "team_instruction" : kind,
                body,
                dedupe_key: crypto.randomUUID(),
              },
              () => setBody(""),
            );
          }}
        >
          <div className="flex flex-wrap gap-2">
            <select
              aria-label="Chat recipient"
              className="rounded border bg-background p-2 text-sm"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
            >
              <option value="orchestrator">To orchestrator</option>
              <option value="team">To team (via orchestrator)</option>
              {members
                .filter((m) => m.id !== feature.orchestrator_member)
                .map((m) => (
                  <option key={m.id} value={`member:${m.id}`}>
                    {m.name}
                    {workerTask(m.id) ? "" : " · consultation required"}
                  </option>
                ))}
              {recipient.startsWith("task:") && (
                <option value={recipient}>Task #{recipient.slice(5)}</option>
              )}
            </select>
            <select
              aria-label="Chat message kind"
              className="rounded border bg-background p-2 text-sm"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              {["question", "answer", "instruction", "decision", "note"].map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
          <Textarea
            aria-label="Team chat message"
            placeholder="A concrete question, answer or decision. Notes are saved without an agent call."
            required
            maxLength={16384}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            A chat message grants no plan, integration or merge approval. Use the existing approval
            controls for those actions.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button disabled={!body.trim() || change.isPending} type="submit">
              Send message
            </Button>
            <Button type="button" variant="outline" onClick={() => setMeeting(!meeting)}>
              Start discussion
            </Button>
          </div>
        </form>
      )}
      {meeting && !closed && (
        <form
          className="rounded border p-3 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            send(
              {
                action: "start_discussion",
                feature_id: feature.id,
                goal,
                member_ids: participants,
                dedupe_key: crypto.randomUUID(),
              },
              () => {
                setMeeting(false);
                setGoal("");
                setParticipants([]);
              },
            );
          }}
        >
          <Input
            aria-label="Discussion goal"
            placeholder="Concrete question to resolve"
            maxLength={4096}
            required
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
          />
          <p className="text-xs">
            Starts real read-only consultant turns. At most {settings.max_consultants} additional
            agents and {settings.max_rounds} rounds; no broadcast or nested delegation.
          </p>
          <div className="flex flex-wrap gap-3">
            {members
              .filter((m) => m.enabled && m.id !== feature.orchestrator_member)
              .map((m) => (
                <label key={m.id} className="text-sm">
                  <input
                    type="checkbox"
                    checked={participants.includes(m.id)}
                    onChange={(e) =>
                      setParticipants(
                        e.target.checked
                          ? [...participants, m.id]
                          : participants.filter((id) => id !== m.id),
                      )
                    }
                  />
                  {m.name}
                </label>
              ))}
          </div>
          <Button
            disabled={
              change.isPending ||
              !participants.length ||
              participants.length > settings.max_consultants
            }
          >
            Consult selected agents
          </Button>
        </form>
      )}
      {discussions.map((d) => (
        <div className="rounded border p-3 space-y-2" key={d.id}>
          <h3 className="font-medium text-sm">
            {d.goal} · {d.state} · round {d.round}/{d.max_rounds}
          </h3>
          {d.summary && <p className="whitespace-pre-wrap text-sm">Decision: {d.summary}</p>}
          {d.state !== "Closed" && !closed && (
            <>
              {d.state === "AwaitingDecision" && d.round < d.max_rounds && (
                <div className="flex gap-2">
                  <Input
                    aria-label="Discussion follow-up"
                    value={followUp}
                    onChange={(e) => setFollowUp(e.target.value)}
                    placeholder="Specific next question"
                  />
                  <Button
                    disabled={!followUp.trim() || change.isPending}
                    onClick={() =>
                      send(
                        { action: "advance_discussion", discussion_id: d.id, question: followUp },
                        () => setFollowUp(""),
                      )
                    }
                  >
                    Next round
                  </Button>
                </div>
              )}
              {(d.round >= d.max_rounds || d.state === "AwaitingUser") && (
                <p className="text-sm">Decision required. Further automatic rounds are blocked.</p>
              )}
              <Textarea
                aria-label="Discussion closing decision"
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                placeholder="Decision or escalation; end this discussion"
              />
              <Button
                variant="outline"
                disabled={!summary.trim() || change.isPending}
                onClick={() =>
                  send({ action: "close_discussion", discussion_id: d.id, summary }, () =>
                    setSummary(""),
                  )
                }
              >
                Close discussion
              </Button>
            </>
          )}
        </div>
      ))}
      <details>
        <summary className="text-xs cursor-pointer">Project discussion limits</summary>
        <div className="flex flex-wrap gap-2 mt-2">
          <label className="text-xs">
            Consultants
            <Input
              aria-label="Maximum consultants"
              type="number"
              min={1}
              max={4}
              value={limitAgents}
              onChange={(e) => setLimitAgents(Number(e.target.value))}
            />
          </label>
          <label className="text-xs">
            Rounds
            <Input
              aria-label="Maximum discussion rounds"
              type="number"
              min={1}
              max={4}
              value={limitRounds}
              onChange={(e) => setLimitRounds(Number(e.target.value))}
            />
          </label>
          <Button
            size="sm"
            variant="outline"
            disabled={change.isPending}
            onClick={() =>
              send({
                action: "chat_settings",
                max_consultants: limitAgents,
                max_rounds: limitRounds,
              })
            }
          >
            Save limits
          </Button>
        </div>
      </details>
    </section>
  );
}
