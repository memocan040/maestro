import { useState } from "react";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Textarea } from "@/ui/textarea";
import { Checkbox } from "@/ui/checkbox";
import { AgentConfigFields } from "@/components/common/agent-config/AgentConfigFields";
import { useAgentProfilesQuery, useSaveAgentProfilesMutation } from "@/services/project.service";
import {
  useOrchestration,
  useOrchestrationMutation,
  useTeamProviders,
} from "@/services/orchestration.service";
import { useAgentConfigQuery } from "@/services/execution.service";
import { useAgentAuthInfoQuery } from "@/services/acp-auth.service";
import { useSelectedProject } from "@/store/projectStore";
import type { AgentProfile, ConnectionKey, TeamMember, TeamProvider } from "@/types/bindings";

const roles = ["orchestrator", "planner", "refiner", "worker", "reviewer"] as const;
type Draft = { member: TeamMember; profile: AgentProfile; newProfile: boolean };

function MemberStatus({
  provider,
  connection,
}: {
  provider?: TeamProvider;
  connection: ConnectionKey;
}) {
  const auth = useAgentAuthInfoQuery(provider?.id ?? null, connection);
  return (
    <span className="text-xs text-muted-foreground">
      {!provider
        ? "Provider unavailable"
        : !provider.installed
          ? "Setup required"
          : auth.data?.authenticated
            ? "Authenticated · connection not tested"
            : "Connection not tested"}
    </span>
  );
}

function TeamEditor({
  draft,
  setDraft,
  providers,
  profiles,
  projectId,
  connection,
  pending,
  onSave,
  onCancel,
}: {
  draft: Draft;
  setDraft: (draft: Draft) => void;
  providers: TeamProvider[];
  profiles: AgentProfile[];
  projectId: number;
  connection: ConnectionKey;
  pending: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const path = useSelectedProject()?.path ?? null;
  const provider = providers.find((p) => p.id === draft.profile.agent_id);
  const probe = useAgentConfigQuery(
    draft.profile.agent_id,
    path,
    projectId,
    connection,
    draft.profile.model ?? null,
    false,
  );
  const auth = useAgentAuthInfoQuery(draft.profile.agent_id || null, connection);
  const patchMember = (patch: Partial<TeamMember>) =>
    setDraft({ ...draft, member: { ...draft.member, ...patch } });
  const patchProfile = (patch: Partial<AgentProfile>) =>
    setDraft({ ...draft, profile: { ...draft.profile, ...patch } });
  return (
    <form
      className="rounded-lg border bg-muted/20 p-4 space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <h3 className="font-semibold">Configure team member</h3>
      <label className="block text-sm">
        Agent provider
        <select
          aria-label="Team provider"
          className="mt-1 w-full rounded border bg-background p-2"
          value={draft.profile.agent_id}
          required
          onChange={(e) => {
            const id = crypto.randomUUID();
            setDraft({
              ...draft,
              newProfile: true,
              member: { ...draft.member, profile_id: id },
              profile: {
                ...draft.profile,
                id,
                agent_id: e.target.value,
                model: null,
                effort: null,
                permission_mode: null,
              },
            });
          }}
        >
          <option value="">Choose provider</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.installed ? "" : " · Setup required"}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm">
        Agent profile
        <select
          aria-label="Team profile"
          className="mt-1 w-full rounded border bg-background p-2"
          value={draft.newProfile ? "new" : draft.profile.id}
          onChange={(e) => {
            const profile = profiles.find((p) => p.id === e.target.value);
            if (profile)
              setDraft({
                ...draft,
                newProfile: false,
                profile: { ...profile },
                member: { ...draft.member, profile_id: profile.id },
              });
            else {
              const id = crypto.randomUUID();
              setDraft({
                ...draft,
                newProfile: true,
                profile: { ...draft.profile, id },
                member: { ...draft.member, profile_id: id },
              });
            }
          }}
        >
          <option value="new">Create independent profile</option>
          {profiles
            .filter((p) => p.agent_id === draft.profile.agent_id)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </select>
      </label>
      {!draft.newProfile && (
        <p className="text-xs text-muted-foreground">
          Settings belong to the shared profile. Other members using this profile receive these
          edits. Duplicate a member for independent settings.
        </p>
      )}
      <label className="block text-sm">
        Member name
        <Input
          aria-label="Member name"
          required
          value={draft.member.name}
          onChange={(e) => patchMember({ name: e.target.value })}
        />
      </label>
      <div className="flex flex-wrap gap-3">
        {roles.map((role) => (
          <label key={role} className="flex items-center gap-1 text-sm">
            <Checkbox
              aria-label={`Team role ${role}`}
              checked={draft.member[role] ?? false}
              onCheckedChange={(v) => patchMember({ [role]: v === true })}
            />
            {role[0].toUpperCase() + role.slice(1)}
          </label>
        ))}
      </div>
      <AgentConfigFields
        value={draft.profile}
        label={draft.member.name || "Team agent"}
        agents={providers}
        projectId={projectId}
        projectPath={path}
        connection={connection}
        readOnly={!draft.member.worker}
        probeAvailable={provider?.installed === true}
        onChange={patchProfile}
      />
      <label className="block text-sm">
        Individual instructions
        <Textarea
          aria-label="Team instructions"
          value={draft.profile.role_prompt ?? ""}
          onChange={(e) => patchProfile({ role_prompt: e.target.value })}
        />
      </label>
      <label className="block text-sm">
        Specialty
        <Input
          aria-label="Team specialty"
          value={draft.member.strengths}
          onChange={(e) => patchMember({ strengths: e.target.value })}
        />
      </label>
      <div className="flex gap-3">
        <label className="text-sm">
          Maximum sessions
          <Input
            aria-label="Maximum member sessions"
            type="number"
            min={1}
            max={16}
            required
            value={draft.member.max_sessions}
            onChange={(e) => patchMember({ max_sessions: Number(e.target.value) })}
          />
        </label>
        <label className="text-sm">
          Priority
          <Input
            aria-label="Team priority"
            type="number"
            value={draft.member.priority}
            onChange={(e) => patchMember({ priority: Number(e.target.value) })}
          />
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={draft.member.enabled}
          onCheckedChange={(v) => patchMember({ enabled: v === true })}
        />
        Enabled
      </label>
      <div className="space-y-1 text-sm">
        <Button
          type="button"
          variant="outline"
          disabled={!provider?.installed || probe.isFetching}
          onClick={() => {
            void probe.refetch().then(() => auth.refetch());
          }}
        >
          Test Connection
        </Button>
        <p>
          Registry: {provider ? "present" : "unavailable"} · ACP executable:{" "}
          {provider?.installed ? "found" : "setup required"}
        </p>
        {probe.isFetching && <p>Testing ACP handshake and session creation…</p>}
        {probe.error && (
          <p role="alert" className="text-destructive">
            {probe.error.message}
          </p>
        )}
        {probe.isSuccess && (
          <p>
            ACP handshake and session creation passed. {probe.data?.models.length ?? 0} models,{" "}
            {probe.data?.modes.length ?? 0} permission modes. No prompt was sent.
          </p>
        )}
        {auth.data && !auth.data.authenticated && auth.data.authMethods.length > 0 && (
          <p>Authentication required. Use Agents &amp; sign-in to authenticate this provider.</p>
        )}
        {provider?.id === "antigravity-acp" && (
          <p>
            Google Antigravity uses the official agy_acp_server, separately from the agy CLI. Setup
            and verified download instructions are in the Custom orchestration documentation.
          </p>
        )}
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={pending || !roles.some((r) => draft.member[r])}>
          Save agent
        </Button>
        <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
          Cancel editing
        </Button>
      </div>
    </form>
  );
}

export function AgentTeamSection({
  projectId,
  connection,
}: {
  projectId: number;
  connection: ConnectionKey;
}) {
  const query = useOrchestration(projectId);
  const profiles = useAgentProfilesQuery(projectId);
  const providers = useTeamProviders(connection);
  const save = useOrchestrationMutation(projectId);
  const saveProfiles = useSaveAgentProfilesMutation();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stored = profiles.data?.profiles ?? [];
  const pending = save.isPending || saveProfiles.isPending;
  const mutate = (operation: Record<string, unknown>) => {
    setError(null);
    save.mutate(operation, { onError: (e) => setError(e.message) });
  };
  function edit(member?: TeamMember, duplicate = false) {
    const existing = stored.find((p) => p.id === member?.profile_id);
    const profileId = duplicate || !existing ? crypto.randomUUID() : existing.id;
    const profile: AgentProfile = {
      name: "Team profile",
      role: "Coder",
      agent_id: "",
      skills: [],
      mcp_servers: [],
      fallback_behaviour: "Warn",
      ...existing,
      id: profileId,
    };
    const value: TeamMember = {
      strengths: "",
      enabled: true,
      orchestrator: false,
      planner: false,
      refiner: false,
      worker: true,
      reviewer: false,
      max_sessions: 1,
      priority: 0,
      ...member,
      id: duplicate || !member ? crypto.randomUUID() : member.id,
      profile_id: profileId,
      name: duplicate ? `${member?.name} copy` : (member?.name ?? ""),
    };
    setDraft({ newProfile: duplicate || !existing, profile, member: value });
    setError(null);
  }
  async function persist() {
    if (!draft || !profiles.data) return;
    setError(null);
    try {
      const profile: AgentProfile = {
        ...draft.profile,
        name: draft.newProfile ? draft.member.name : draft.profile.name,
        role: draft.newProfile
          ? draft.member.worker
            ? "Coder"
            : draft.member.reviewer
              ? "Reviewer"
              : draft.member.planner || draft.member.orchestrator
                ? "Planner"
                : "Refiner"
          : draft.profile.role,
      };
      await saveProfiles.mutateAsync({
        projectId,
        document: {
          ...profiles.data,
          profiles: [...stored.filter((p) => p.id !== profile.id), profile],
        },
      });
      await save.mutateAsync({ action: "save_member", member: draft.member });
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  return (
    <section className="rounded-lg border bg-card p-4 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold">Agent Team</h2>
        <Button disabled={pending || !profiles.data || !providers.data} onClick={() => edit()}>
          + Add Agent
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Independent project team members. Reuse any provider as often as needed; choose the classic
        task pipeline separately below.
      </p>
      {(query.isLoading || providers.isLoading) && <p>Loading team and registry…</p>}
      {(error || query.error || providers.error || profiles.error) && (
        <p role="alert" className="text-destructive">
          {error ?? query.error?.message ?? providers.error?.message ?? profiles.error?.message}
        </p>
      )}
      {draft && (
        <TeamEditor
          key={draft.member.id}
          draft={draft}
          setDraft={setDraft}
          profiles={stored}
          providers={providers.data ?? []}
          projectId={projectId}
          connection={connection}
          pending={pending}
          onSave={() => {
            void persist();
          }}
          onCancel={() => setDraft(null)}
        />
      )}
      {!query.isLoading && !query.data?.members.length && (
        <p className="text-sm text-muted-foreground">
          No team members yet. Add a provider and configure its profile.
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {query.data?.members.map((m) => {
          const profile = stored.find((p) => p.id === m.profile_id);
          const provider = providers.data?.find((p) => p.id === profile?.agent_id);
          return (
            <article key={m.id} className="rounded-lg border p-3 space-y-2">
              <div className="flex justify-between gap-2">
                <strong>{m.name}</strong>
                <span className="text-xs">{m.enabled ? "Enabled" : "Disabled"}</span>
              </div>
              <p className="text-sm">
                {provider?.name ?? profile?.agent_id ?? "Profile missing"} ·{" "}
                {profile?.model ?? "Provider default model"}
              </p>
              <p className="text-xs">
                {roles.filter((r) => m[r]).join(" · ")} · Max sessions: {m.max_sessions}
              </p>
              <MemberStatus provider={provider} connection={connection} />
              <div className="flex flex-wrap gap-2">
                <Button
                  aria-label={`Edit ${m.name}`}
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => edit(m)}
                >
                  Edit
                </Button>
                <Button
                  aria-label={`Duplicate ${m.name}`}
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => edit(m, true)}
                >
                  Duplicate
                </Button>
                <Button
                  aria-label={`${m.enabled ? "Deactivate" : "Activate"} ${m.name}`}
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    mutate({ action: "save_member", member: { ...m, enabled: !m.enabled } })
                  }
                >
                  {m.enabled ? "Deactivate" : "Activate"}
                </Button>
                <Button
                  aria-label={`Remove ${m.name}`}
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => mutate({ action: "remove_member", member_id: m.id })}
                >
                  Remove
                </Button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
