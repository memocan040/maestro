import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { startTask, taskQueryKeys } from "@/services/task.service";

import type { OrchestrationSnapshot } from "@/types/bindings";
export type {
  TeamMember,
  PlannedTask,
  Feature,
  FeatureMessage,
  OrchestrationSnapshot,
} from "@/types/bindings";
export const orchestrationKeys = {
  base: ["orchestration"] as const,
  project: (id: number) => ["orchestration", id] as const,
};

export function orchestrationRequest(projectId: number, operation: Record<string, unknown>) {
  return invoke<OrchestrationSnapshot>("orchestration", { projectId, operation });
}
export function useOrchestration(projectId: number) {
  return useQuery({
    queryKey: orchestrationKeys.project(projectId),
    queryFn: () => orchestrationRequest(projectId, { action: "snapshot" }),
    enabled: projectId > 0,
  });
}
export function useOrchestrationMutation(projectId: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (operation: Record<string, unknown>) => orchestrationRequest(projectId, operation),
    onSuccess: (snapshot) => {
      client.setQueryData(orchestrationKeys.project(projectId), snapshot);
      void client.invalidateQueries({ queryKey: taskQueryKeys.lists() });
    },
  });
}
export function useStartOrchestrator(projectId: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (taskId: number) => startTask(projectId, taskId, "Planner", null, false, true),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: taskQueryKeys.lists() });
    },
  });
}
