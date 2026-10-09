import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/**
 * E2E against the real binary: real Rust backend, real SQLite, real webview.
 *
 * Run it with `bun run test:e2e`, which builds the binary first. See tests/e2e/README.md —
 * this needs a display and the platform webview runtime.
 */

/**
 * Cargo puts the binary at the *workspace* root, not under src-tauri/, because this repo is a
 * three-crate workspace. The service spawns this path verbatim and no longer resolves binaries
 * itself, so pointing at src-tauri/target would fail with a bare ENOENT.
 */
const APP_BINARY =
  process.env.MAESTRO_E2E_BINARY ??
  join(
    process.cwd(),
    "target",
    "release",
    process.platform === "win32" ? "maestro.exe" : "maestro",
  );

/**
 * The app opens whatever database lives in its app-data directory. Without this the suite would
 * run against — and migrate, and write to — the real Maestro install of whoever ran it. Point
 * the OS-specific data directory at a throwaway so every run starts from an empty schema.
 *
 * MAESTRO_CUSTOM_DATA_DIR explicitly isolates the Custom app and its local daemon on every
 * platform. OS directory overrides also isolate components using their platform defaults.
 */
/**
 * This module is evaluated once in the launcher and again in every worker, so minting a
 * directory unconditionally would create one per process — leaving the app using a worker's
 * copy while onComplete deleted the launcher's. Recording it in the environment makes the
 * launcher's directory the one workers inherit, and the one that gets cleaned up.
 */
function isolatedAppDataDir(): string {
  const existing = process.env.MAESTRO_E2E_DATA_DIR;
  if (existing) {
    const path = resolve(existing);
    if (dirname(path) !== resolve(tmpdir()) || !basename(path).startsWith("maestro-e2e-")) {
      throw new Error(
        "MAESTRO_E2E_DATA_DIR must be a maestro-e2e-* directory directly inside TEMP",
      );
    }
    return path;
  }
  const created = mkdtempSync(join(tmpdir(), "maestro-e2e-"));
  process.env.MAESTRO_E2E_DATA_DIR = created;
  return created;
}

const appDataDir = isolatedAppDataDir();
const driverProvider =
  process.env.MAESTRO_E2E_DRIVER_PROVIDER ??
  (process.platform === "win32" ? "external" : "embedded");
if (driverProvider !== "external" && driverProvider !== "embedded") {
  throw new Error("MAESTRO_E2E_DRIVER_PROVIDER must be external or embedded");
}

const isolatedEnv: Record<string, string> = {
  MAESTRO_CUSTOM_DATA_DIR: appDataDir,
  ...(process.platform === "win32"
    ? { APPDATA: appDataDir, LOCALAPPDATA: appDataDir }
    : { XDG_DATA_HOME: appDataDir, XDG_CONFIG_HOME: appDataDir }),
};

// The app inherits its environment from the driver, which inherits it from this process.
Object.assign(process.env, isolatedEnv);

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./tests/e2e/**/*.spec.ts"],

  /**
   * One at a time. `project/lock.rs` takes a file lock per project and the whole suite shares a
   * single SQLite file, so parallel workers would fight over both.
   */
  maxInstances: 1,

  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": { application: APP_BINARY },
    } as WebdriverIO.Capabilities,
  ],

  services: [
    [
      "@wdio/tauri-service",
      {
        appBinaryPath: APP_BINARY,
        driverProvider,
        autoInstallTauriDriver: driverProvider === "external",
        autoDownloadEdgeDriver: true,
        env: isolatedEnv,
        // Surface Rust panics and console errors in the WDIO output — with no logging in the
        // Rust code, a crash is otherwise a silent, unexplained session failure.
        captureBackendLogs: true,
        captureFrontendLogs: true,
        // Cold start pays for SQLite schema creation and the ACP discovery sweep.
        startTimeout: 120_000,
      },
    ],
  ],

  framework: "mocha",
  reporters: ["spec"],
  logLevel: "warn",
  mochaOpts: { ui: "bdd", timeout: 120_000 },

  /**
   * Home attaches to This computer as it opens, deploying its server on a fresh data directory,
   * and its panel fills in once that answers. The default 3s can expire inside that window on a
   * slow machine, so element assertions get a wider budget; they still return as soon as the
   * element settles.
   */
  waitforTimeout: 15_000,

  async onComplete() {
    // The resident daemon intentionally outlives its window. Stop only the daemon
    // authenticated by this run's isolated runtime file before removing SQLite files.
    const runtimeFile = join(appDataDir, "daemon", "runtime.json");
    if (existsSync(runtimeFile)) {
      const runtime = JSON.parse(readFileSync(runtimeFile, "utf8")) as {
        port: number;
        token: string;
      };
      await new Promise<void>((done) => {
        const socket = createConnection({ host: "127.0.0.1", port: runtime.port });
        socket.once("connect", () => socket.end(`${runtime.token}\nSHUTDOWN\n`));
        socket.setTimeout(3_000, () => socket.destroy());
        socket.once("error", () => socket.destroy());
        socket.once("close", () => done());
      });
      for (let attempt = 0; existsSync(runtimeFile) && attempt < 50; attempt++) {
        await new Promise((done) => setTimeout(done, 100));
      }
      if (existsSync(runtimeFile)) throw new Error("The isolated test daemon did not stop");
    }
    try {
      rmSync(appDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || (code !== "EPERM" && code !== "EBUSY")) throw error;
      console.warn(`Windows retained temporary test data after daemon shutdown: ${appDataDir}`);
    }
  },
};
