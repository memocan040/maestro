type UpdateStatus =
  | { phase: "idle" | "checking" | "upToDate" }
  | { phase: "available"; version: string; notes: string | null }
  | { phase: "downloading"; progress: number; version: string }
  | { phase: "error"; message: string };

// Custom builds use manual distribution until a fork-owned signed update channel exists.
export function useUpdater() {
  return {
    status: { phase: "upToDate" } as UpdateStatus,
    lastChecked: null as Date | null,
    isPackageInstall: false,
    checkForUpdates: async (_autoUpdate: boolean) => {},
    install: async () => {
      throw new Error("Automatic updates are disabled in Maestro Custom");
    },
    downloadPackage: async (_version: string) => {
      throw new Error("Install a verified Maestro Custom package manually");
    },
  };
}
