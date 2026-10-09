import { useState } from "react";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Checkbox } from "@/ui/checkbox";
import { useAgentProfilesQuery } from "@/services/project.service";
import {
  useOrchestration,
  useOrchestrationMutation,
  type TeamMember,
} from "@/services/orchestration.service";

export function AgentTeamSection({ projectId }: { projectId: number }) {
  const query = useOrchestration(projectId);
  const profiles = useAgentProfilesQuery(projectId);
  const save = useOrchestrationMutation(projectId);
  const [error, setError] = useState<string | null>(null);
  const commit = (member: TeamMember) => {
    setError(null);
    save.mutate({ action: "save_member", member }, { onError: (e) => setError(e.message) });
  };
  return (
    <section className="rounded-lg border bg-card p-4 space-y-4">
      <h2 className="font-semibold">Agent Team</h2>
      <p className="text-sm text-muted-foreground">
        Team members use your existing agent profiles, models and MCP settings. Availability and
        sign-in are checked when a session starts.
      </p>
      {query.isLoading && <p>Loading team…</p>}
      {(error || query.error) && (
        <p role="alert" className="text-destructive">
          {error ?? query.error?.message}
        </p>
      )}
      {query.data?.members.map((m) => (
        <div key={m.id} className="rounded border p-3 space-y-2">
          <Input
            aria-label="Member name"
            defaultValue={m.name}
            onBlur={(e) => {
              if (e.target.value !== m.name) commit({ ...m, name: e.target.value });
            }}
          />
          <p className="text-xs text-muted-foreground">
            {profiles.data?.profiles?.find((p) => p.id === m.profile_id)?.name ?? "Profile missing"}
          </p>
          <Input
            aria-label="Strengths"
            defaultValue={m.strengths}
            placeholder="Strengths, languages, specialties"
            onBlur={(e) => {
              if (e.target.value !== m.strengths) commit({ ...m, strengths: e.target.value });
            }}
          />
          <div className="flex flex-wrap gap-3 text-sm">
            {(["enabled", "orchestrator", "worker", "reviewer"] as const).map((key) => (
              <label key={key} className="flex items-center gap-1">
                <Checkbox
                  disabled={save.isPending}
                  checked={m[key]}
                  onCheckedChange={(value) => commit({ ...m, [key]: value === true })}
                />
                {key}
              </label>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm">
            Maximum sessions
            <Input
              type="number"
              className="w-20"
              aria-label="Maximum member sessions"
              min={1}
              max={16}
              defaultValue={m.max_sessions}
              onBlur={(e) => {
                const value = Number(e.target.value);
                if (value !== m.max_sessions) commit({ ...m, max_sessions: value });
              }}
            />
          </label>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        {profiles.data?.profiles?.map((p) => (
          <Button
            key={p.id}
            variant="outline"
            size="sm"
            disabled={save.isPending || query.data?.members.some((m) => m.profile_id === p.id)}
            onClick={() =>
              commit({
                id: crypto.randomUUID(),
                profile_id: p.id,
                name: p.name,
                strengths: "",
                enabled: true,
                orchestrator: p.role === "Planner",
                worker: p.role === "Coder",
                reviewer: p.role === "Reviewer",
                max_sessions: 1,
                priority: 0,
              })
            }
          >
            Add {p.name}
          </Button>
        ))}
      </div>
      {profiles.data?.profiles?.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Create agent profiles below, then add them to your team.
        </p>
      )}
    </section>
  );
}
