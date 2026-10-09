# End-to-end tests

These drive the real Maestro Custom binary through WebdriverIO: Rust backend, SQLite and
platform webview. They require a desktop display and are separate from Vitest.

## Prerequisites

Use Bun, Node 20+, the Rust/platform build toolchain and a display. Windows requires WebView2;
the service installs `tauri-driver` and downloads a matching Edge driver. Linux requires
WebKitGTK and `webkit2gtk-driver`; `xvfb-run` provides a headless display.

## Running

```bash
bun run test:e2e          # build with the Tauri CLI, then run
bun run test:e2e:run      # use the current target/release binary
```

Windows defaults to `external` and builds the normal app without `wdio`. Other platforms retain
the `embedded` provider and its test-only `wdio` feature. `MAESTRO_E2E_DRIVER_PROVIDER` explicitly
selects either provider. Never distribute an app built with `wdio`.

The embedded Windows plugin currently fails to compile because its Windows/WebView2 bindings
differ from the app's Tauri dependencies. The external lane was verified with Windows and
WebView2 154.0.4258.62. Window-focus/frontend-log helpers may emit plugin-unavailable warnings;
the smoke tests use native WebDriver and direct Tauri IPC.

PowerShell, testing a particular binary and saving a screenshot:

```powershell
$env:MAESTRO_E2E_BINARY = "$PWD\target\release\maestro.exe"
$env:MAESTRO_E2E_SCREENSHOT = "$env:TEMP\maestro-custom-home.png"
bun run test:e2e:run
```

Always build through the Tauri CLI so the frontend is bundled. Plain `cargo build` can leave a
binary pointing at the Vite development URL. A matching version alone does not prove matching
source; rebuild after code changes.

## Isolation and scope

`wdio.conf.ts` sets `MAESTRO_CUSTOM_DATA_DIR` to a fresh temporary directory shared by launcher
and workers. The app and local daemon therefore use temporary data on every platform. The
suite also redirects platform data-directory environment variables and removes its temporary
directory afterwards. It first asks only that directory's authenticated daemon to shut down and
requires its runtime file to disappear. Windows may retain the temporary directory with an
`EPERM`/`EBUSY` warning after shutdown; this retention is reported separately from test results.
Do not point `MAESTRO_E2E_DATA_DIR` at real app data; only `maestro-e2e-*` directories directly
inside TEMP are accepted.

The five smoke assertions cover window title, Home rendering, the local computer entry, real
IPC/schema initialization and app version. They do not prove Feature planning, worker execution,
review, integration or restart recovery. Those require the dedicated ACP acceptance fixtures
listed in `docs/custom-orchestration-progress.md`. The Custom app has no updater plugin.
