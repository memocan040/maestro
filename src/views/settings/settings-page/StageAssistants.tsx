import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AgentRole, ConnectionKey } from "@/types/bindings";

/** Optional providers for a single existing Maestro pipeline stage. No second team model. */
export function StageAssistants({
  role,
  agents,
  connection,
  projectPath,
}: {
  role: AgentRole;
  agents: Array<{ id: string; name: string }>;
  connection: ConnectionKey;
  projectPath: string | null;
}) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = projectPath
    ? projectPath.replace(/[\\/]+$/, "") + "/.maestro/assistants.json"
    : null;

  useEffect(() => {
    let alive = true;
    setLoaded(false);
    setSelected({});
    setError(null);
    if (!path) return;
    void invoke<string>("read_file", { connection, path })
      .then((raw) => {
        const parsed: unknown = JSON.parse(raw);
        if (alive && parsed && typeof parsed === "object" && "by_role" in parsed) {
          setSelected(
            (parsed as { by_role?: Record<string, string[]> }).by_role ?? {},
          );
        }
      })
      .catch(() => {
        // Missing file means no assistants are configured.
      })
      .finally(() => {
        if (alive) setLoaded(true);
      });
    return () => { alive = false; };
  }, [path, connection]);

  const update = (id: string, checked: boolean) => {
    if (!path || !loaded) return;
    const existing = selected[role] ?? [];
    const byRole = {
      ...selected,
      [role]: checked
        ? [...new Set([...existing, id])]
        : existing.filter((item) => item !== id),
    };
    setSelected(byRole);
    setError(null);
    void invoke("write_file", {
      connection,
      path,
      contents: JSON.stringify({ by_role: byRole }, null, 2) + "\n",
    }).catch((e) => {
      setSelected(selected);
      setError(String(e));
    });
  };

  if (!projectPath || !agents.length) return null;
  return (
    <div className="rounded-md border border-border/60 p-3 space-y-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-xs font-medium">Assistants</span>
        <span className="text-[11px] text-muted-foreground">
          Optional helpers · launched only when the main agent delegates
        </span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {agents.map((agent) => (
          <label key={agent.id} className="flex items-center gap-1.5 text-xs cursor-pointer">
            <input
              type="checkbox"
              aria-label={role + " assistant " + agent.name}
              disabled={!loaded}
              checked={(selected[role] ?? []).includes(agent.id)}
              onChange={(e) => update(agent.id, e.target.checked)}
            />
            {agent.name}
          </label>
        ))}
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
