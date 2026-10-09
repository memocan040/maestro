import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  watch,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  readdirSync,
  openSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const devData = join(root, ".maestro", "custom-dev-data");
const stagedDir = join(devData, "server-assets");
const daemonName = "maestro-custom-server-windows-x86_64.exe";
const stateFile = join(devData, "launcher.json");
let logFile;
let app;
let restarting = false;

function log(message) {
  const text = `${new Date().toISOString()} ${message}\n`;
  if (logFile) writeFileSync(logFile, text, { flag: "a" });
  console.log(message);
}

function powershell(script) {
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { encoding: "utf8", windowsHide: true },
  ).trim();
}

function quote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function dialog(message, confirm = false) {
  const response = powershell(
    `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show(${quote(message)}, 'Maestro Custom', '${confirm ? "YesNo" : "OK"}', '${confirm ? "Warning" : "Information"}')`,
  );
  return response === "Yes";
}

function bunPath() {
  const candidates = [
    process.env.MAESTRO_BUN_EXECUTABLE,
    join(process.env.APPDATA ?? "", "npm", "node_modules", "bun", "bin", "bun.exe"),
    join(process.env.USERPROFILE ?? "", ".bun", "bin", "bun.exe"),
    ...process.env.PATH.split(";").map((directory) => join(directory, "bun.exe")),
  ];
  const binary = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!binary) throw new Error("Bun nicht gefunden. Installiere Bun und starte erneut.");
  return binary;
}

function buildEnv() {
  const env = { ...process.env, CARGO_BUILD_JOBS: "4" };
  delete env.MAESTRO_TEST_MANIFEST;
  if (!env.RC) {
    const kits = join(
      process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)",
      "Windows Kits",
      "10",
      "bin",
    );
    if (existsSync(kits)) {
      const versions = readdirSync(kits).sort((a, b) =>
        b.localeCompare(a, undefined, { numeric: true }),
      );
      env.RC = versions.map((version) => join(kits, version, "x64", "rc.exe")).find(existsSync);
    }
  }
  return env;
}

function run(command, args, env = buildEnv()) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd: root, env, windowsHide: true });
    child.stdout.on("data", (data) => log(data.toString().trimEnd()));
    child.stderr.on("data", (data) => log(data.toString().trimEnd()));
    child.once("error", fail);
    child.once("exit", (code) =>
      code === 0 ? done() : fail(new Error(`${command} exit ${code}`)),
    );
  });
}

export function daemonRequest(runtime, request) {
  return new Promise((done, fail) => {
    const socket = createConnection({ host: "127.0.0.1", port: runtime.port });
    let buffer = Buffer.alloc(0);
    let handshaken = false;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) fail(error);
      else done(result);
    };
    const frame = (value) => {
      const body = Buffer.from(JSON.stringify({ request: value }));
      const size = Buffer.alloc(4);
      size.writeUInt32LE(body.length);
      socket.write(Buffer.concat([size, body]));
    };
    socket.setTimeout(5_000, () => finish(new Error("Daemon antwortet nicht")));
    socket.once("error", (error) => finish(error));
    socket.once("close", () => {
      if (!settled) finish(new Error("Daemon-Verbindung vor Antwort geschlossen"));
    });
    socket.once("connect", () => {
      socket.write(`${runtime.token}\nATTACH\n`);
      frame({ handshake: { protocol_version: runtime.protocol_version } });
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = buffer.readUInt32LE();
        if (size > 16 * 1024 * 1024) return finish(new Error("Ungültiger Daemon-Frame"));
        if (buffer.length < size + 4) break;
        let message;
        try {
          message = JSON.parse(buffer.subarray(4, size + 4).toString()).response;
        } catch (error) {
          return finish(error);
        }
        buffer = buffer.subarray(size + 4);
        if (message?.error) return finish(new Error(message.error.message ?? "Daemon-Fehler"));
        if (message?.handshake_ok && !handshaken) {
          handshaken = true;
          frame(request);
        }
        if (message?.home_summary_ok) return finish(null, message.home_summary_ok.status);
      }
    });
  });
}

export async function shutdownDaemon(dataDir) {
  const runtimePath = join(dataDir, "daemon", "runtime.json");
  if (!existsSync(runtimePath)) return;
  const runtime = JSON.parse(readFileSync(runtimePath));
  if (Number.isSafeInteger(runtime.pid) && runtime.pid > 0) {
    try {
      process.kill(runtime.pid, 0);
    } catch (error) {
      // A crash leaves runtime.json behind. Attach checks the daemon lock and
      // recovers this itself; do not delete its files or signal an unrelated PID.
      if (error.code === "ESRCH") return;
      throw error;
    }
  }
  await new Promise((done) => {
    const socket = createConnection({ host: "127.0.0.1", port: runtime.port });
    socket.once("connect", () => socket.end(`${runtime.token}\nSHUTDOWN\n`));
    socket.setTimeout(3_000, () => socket.destroy());
    socket.once("error", () => socket.destroy());
    socket.once("close", done);
  });
  for (let attempt = 0; existsSync(runtimePath) && attempt < 100; attempt++) {
    await new Promise((done) => setTimeout(done, 100));
  }
  if (existsSync(runtimePath)) throw new Error("Daemon nicht beendet. Kein Austausch erfolgt.");
}

async function approveRestart(dataDir) {
  const runtimePath = join(dataDir, "daemon", "runtime.json");
  if (!existsSync(runtimePath)) return true;
  const runtime = JSON.parse(readFileSync(runtimePath));
  if (Number.isSafeInteger(runtime.pid) && runtime.pid > 0) {
    try {
      process.kill(runtime.pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return true;
      throw error;
    }
  }
  try {
    const status = await daemonRequest(runtime, {
      home_summary: { project_paths: [] },
    });
    if (status.live_sessions === 0 && status.running_runs === 0) return true;
    return dialog(
      `Der neue Dev-Daemon ist fertig gebaut. ${status.live_sessions} Sessions und ${status.running_runs} Automationen sind geöffnet. Neustart unterbricht diese Arbeit. Jetzt Dev-App und Dev-Daemon neu starten? Bei Nein bleibt der bisherige Daemon aktiv.`,
      true,
    );
  } catch {
    return dialog(
      "Der Dev-Daemon antwortet nicht; aktive Arbeit lässt sich nicht ausschließen. Dev-App und Dev-Daemon jetzt neu starten?",
      true,
    );
  }
}

async function stopApp() {
  if (!app || app.exitCode !== null) return;
  restarting = true;
  try {
    execFileSync("taskkill.exe", ["/PID", String(app.pid), "/T", "/F"], { windowsHide: true });
  } catch (error) {
    // taskkill can return failure when a descendant exits during enumeration,
    // even though the launcher and its application were successfully stopped.
    try {
      process.kill(app.pid, 0);
    } catch (probe) {
      if (probe.code !== "ESRCH") throw probe;
      await new Promise((done) => setImmediate(done));
      if (app.exitCode !== null) return;
      await new Promise((done) => app.once("exit", done));
      return;
    }
    throw error;
  }
  await new Promise((done) => (app.exitCode !== null ? done() : app.once("exit", done)));
}

function startApp() {
  const config = join(devData, "tauri.dev.json");
  writeFileSync(
    config,
    JSON.stringify({
      app: {
        windows: [
          {
            label: "main",
            title: "Maestro Custom – Dev",
            width: 1400,
            height: 900,
            resizable: true,
            visible: false,
          },
        ],
      },
    }),
  );
  restarting = false;
  app = spawn(bunPath(), ["run", "tauri", "dev", "--config", config], {
    cwd: root,
    env: { ...buildEnv(), MAESTRO_CUSTOM_DATA_DIR: devData, MAESTRO_CUSTOM_SERVER_DIR: stagedDir },
    windowsHide: true,
  });
  app.stdout.on("data", (data) => log(data.toString().trimEnd()));
  app.stderr.on("data", (data) => log(data.toString().trimEnd()));
  app.once("error", (error) => {
    log(error.message);
    dialog(error.message);
  });
  app.once("exit", (code) => {
    if (!restarting) {
      log(`Dev-Tauri beendet: ${code}. Erneuter Start: bun run custom:dev`);
      process.exit(code ?? 1);
    }
  });
  writeFileSync(stateFile, JSON.stringify({ pid: process.pid, appPid: app.pid, repository: root }));
}

async function dev() {
  if (existsSync(stateFile)) {
    const state = JSON.parse(readFileSync(stateFile));
    try {
      process.kill(state.pid, 0);
      dialog(`Maestro Custom Dev läuft bereits. Build-Log: ${logFile}`);
      return;
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      unlinkSync(stateFile);
    }
  }
  let stateHandle;
  try {
    stateHandle = openSync(stateFile, "wx");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    log("Ein weiterer Dev-Start läuft bereits.");
    return;
  }
  writeFileSync(stateHandle, JSON.stringify({ pid: process.pid, repository: root }));
  closeSync(stateHandle);
  mkdirSync(stagedDir, { recursive: true });
  const source = join(root, "target", "debug", "maestro-server.exe");
  const destination = join(stagedDir, daemonName);
  const digest = (file) =>
    existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : "";
  const rebuild = async (initial = false) => {
    await run("cargo", ["build", "--locked", "-p", "maestro-server", "-j", "4"]);
    if (digest(source) === digest(destination)) {
      if (initial) startApp();
      return;
    }
    if (!(await approveRestart(devData))) {
      log(
        "Daemon-Build bereit, Austausch vom Benutzer zurückgestellt. Erneute Quelländerung oder Dev-Neustart übernimmt ihn.",
      );
      if (initial) startApp();
      return;
    }
    await stopApp();
    await shutdownDaemon(devData);
    copyFileSync(source, destination);
    startApp();
  };
  await rebuild(true);
  let building = false;
  let pending = false;
  let timer;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      pending = true;
      if (building) return;
      building = true;
      while (pending) {
        pending = false;
        try {
          await rebuild();
        } catch (error) {
          log(error.stack);
          dialog(
            `Daemon-Build/Neustart fehlgeschlagen. Bisherige Assets bleiben erhalten.\n${error.message}\nLog: ${logFile}`,
          );
        }
      }
      building = false;
    }, 750);
  };
  for (const folder of ["maestro-server", "maestro-protocol"]) {
    watch(join(root, folder), { recursive: true }, (_event, file) => {
      if (file && /\.(rs|toml|json)$/.test(file)) schedule();
    });
  }
  watch(join(root, "Cargo.toml"), schedule);
  watch(join(root, "Cargo.lock"), schedule);
  log(
    `Dev aktiv. Frontend: Vite HMR; Rust: Tauri-Watcher; Daemon: Build + geschützter Neustart. Daten: ${devData}`,
  );
}

async function buildRelease() {
  const started = Date.now();
  const env = buildEnv();
  delete env.MAESTRO_CUSTOM_SERVER_DIR;
  delete env.MAESTRO_CUSTOM_DATA_DIR;
  await run(bunPath(), ["run", "tauri", "build", "--bundles", "nsis"], env);
  const version = JSON.parse(readFileSync(join(root, "package.json"))).version;
  const installer = join(
    root,
    "target",
    "release",
    "bundle",
    "nsis",
    `Maestro Custom_${version}_x64-setup.exe`,
  );
  if (!existsSync(installer)) throw new Error("Build meldete Erfolg, aber der Installer fehlt.");
  const hash = createHash("sha256").update(readFileSync(installer)).digest("hex");
  log(`Installer fertig (${Date.now() - started} ms): ${installer}\nSHA-256 ${hash}`);
  return { installer, hash };
}

async function update() {
  const { installer, hash } = await buildRelease();
  const installDir = powershell(
    "(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' | Where-Object DisplayName -eq 'Maestro Custom' | Select-Object -First 1).InstallLocation",
  ).replace(/^"|"$/g, "");
  if (!installDir)
    throw new Error(
      "Installierte Custom-App nicht gefunden. Den geprüften Installer manuell öffnen.",
    );
  if (
    !dialog(
      `Der aktuelle Installer wurde erfolgreich gebaut:\n${installer}\nSHA-256 ${hash}\n\nDie installierte Custom-App wird geschlossen. Ihr Daemon wird beendet; laufende Sessions werden unterbrochen. Danach wird ${installDir} aktualisiert. Jetzt installieren?`,
      true,
    )
  ) {
    log("Installation nicht freigegeben. Installer bleibt bereit.");
    return;
  }
  const installedExe = join(installDir, "maestro.exe");
  powershell(
    `$apps=@(Get-Process maestro -ErrorAction SilentlyContinue | Where-Object Path -eq ${quote(installedExe)}); foreach($item in $apps){ if(-not $item.CloseMainWindow()){throw 'App konnte nicht geschlossen werden'}; if(-not $item.WaitForExit(15000)){throw 'App läuft weiter; Update abgebrochen'} }`,
  );
  await shutdownDaemon(join(process.env.APPDATA, "com.memocan040.maestro.custom"));
  await run(installer, ["/S", `/D=${installDir}`]);
  log(`Installierte App aktualisiert: ${installedExe}`);
  spawn(installedExe, [], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

if (
  process.argv[1] &&
  resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
) {
  try {
    if (process.platform !== "win32" && (process.argv[2] ?? "dev") === "dev") {
      await run("bun", ["run", "tauri", "dev"], process.env);
      process.exit(0);
    }
    if (process.platform !== "win32")
      throw new Error("Dieser Desktop-Launcher ist für Windows vorgesehen.");
    mkdirSync(devData, { recursive: true });
    const mode = process.argv[2] ?? "dev";
    logFile = join(devData, mode === "update" ? "update.log" : "dev.log");
    if (mode === "dev") await dev();
    else if (mode === "update") await update();
    else if (mode === "build") await buildRelease();
    else throw new Error(`Unbekannter Modus ${mode}`);
  } catch (error) {
    log(error.stack);
    dialog(`${error.message}\nLog: ${logFile ?? devData}`);
    process.exitCode = 1;
  }
}
