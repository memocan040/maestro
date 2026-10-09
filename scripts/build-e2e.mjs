import { execFileSync } from "node:child_process";

// Windows uses tauri-driver/Edge with the normal app. The embedded driver's Windows
// bindings currently differ from Tauri's; other platforms retain their embedded lane.
const provider =
  process.env.MAESTRO_E2E_DRIVER_PROVIDER ??
  (process.platform === "win32" ? "external" : "embedded");
if (provider !== "external" && provider !== "embedded") {
  throw new Error("MAESTRO_E2E_DRIVER_PROVIDER must be external or embedded");
}
execFileSync(
  "bun",
  [
    "run",
    "tauri",
    "build",
    "--no-bundle",
    ...(provider === "embedded" ? ["--", "--features", "wdio"] : []),
  ],
  { stdio: "inherit" },
);
