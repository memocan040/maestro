import { spawn, execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { shutdownDaemon } from "./custom-desktop.mjs";

// Opt-in real-provider test D. Own project, daemon and session; never uses the prepared feature.
const directory = mkdtempSync(join(tmpdir(), "maestro-team-routing-"));
const project = join(directory, "project").replaceAll("\\", "/");
mkdirSync(project);
const git = (...args) => execFileSync("git", ["-C", project, ...args], { windowsHide: true });
git("init", "-b", "main");
writeFileSync(join(project, "README.md"), "# Isolated team routing acceptance\n");
git("add", ".");
git(
  "-c",
  "user.name=Maestro Test",
  "-c",
  "user.email=test@example.invalid",
  "-c",
  "commit.gpgsign=false",
  "commit",
  "-m",
  "Initialize fixture",
);
mkdirSync(join(project, ".maestro"));
writeFileSync(
  join(project, ".maestro", "profiles.json"),
  JSON.stringify({
    profiles: [
      { id: "default", name: "Default Claude", role: "Coder", agent_id: "claude-acp" },
      {
        id: "selected",
        name: "Selected Cursor",
        role: "Coder",
        agent_id: "cursor",
        role_prompt:
          "Connectivity test only. Never use tools. Reply MAESTRO_TEAM_ROUTING_OK and end the turn.",
      },
      { id: "lead", name: "Lead", role: "Planner", agent_id: "codex-acp" },
    ],
    defaults: { Coder: "default" },
  }),
);
const binary = join(directory, "verified-server.exe");
copyFileSync(
  resolve(process.env.MAESTRO_HARNESS_TEST_SERVER ?? "target/debug/maestro-server.exe"),
  binary,
);
mkdirSync(join(directory, "daemon"));
const child = spawn(binary, ["attach"], {
  cwd: directory,
  windowsHide: true,
  stdio: ["pipe", "pipe", "ignore"],
  env: {
    ...process.env,
    MAESTRO_CUSTOM_DATA_DIR: directory,
    MAESTRO_CUSTOM_DAEMON_DIR: join(directory, "daemon"),
  },
});
let buffer = Buffer.alloc(0);
const listeners = new Set();
const messages = [];
child.stdout.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE() + 4) {
    const size = buffer.readUInt32LE();
    const response = JSON.parse(buffer.subarray(4, size + 4)).response;
    buffer = buffer.subarray(size + 4);
    if (!response || response.ping || response.diagnostic) continue;
    const listener = [...listeners].find((l) => l.predicate(response));
    if (listener) listener.done(response);
    else messages.push(response);
  }
});
const send = (request) => {
  const body = Buffer.from(JSON.stringify({ request }));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  child.stdin.write(Buffer.concat([header, body]));
};
const next = (predicate, timeout = 120_000) =>
  new Promise((resolveNext, reject) => {
    const index = messages.findIndex(predicate);
    if (index >= 0) return resolveNext(messages.splice(index, 1)[0]);
    const listener = {
      predicate,
      done: (value) => {
        clearTimeout(timer);
        listeners.delete(listener);
        resolveNext(value);
      },
    };
    const timer = setTimeout(() => {
      listeners.delete(listener);
      reject(new Error("Timed out waiting for daemon/provider"));
    }, timeout);
    listeners.add(listener);
  });
const request = async (payload, key, timeout = 120_000) => {
  console.log(
    JSON.stringify({
      stage: "request",
      request: Object.keys(payload)[0],
      action: payload.orchestration?.operation.action,
    }),
  );
  send(payload);
  const response = await next((m) => m[key] || m.error, timeout).catch((error) => {
    throw new Error(`${key}: ${error.message}`);
  });
  if (response.error) throw new Error(response.error.message);
  return response[key];
};
const operation = (operation) =>
  request({ orchestration: { project_path: project, operation } }, "orchestration_ok");
let session;
let feature;
try {
  await request({ handshake: { protocol_version: 15 } }, "handshake_ok");
  for (const [profile, worker, orchestrator] of [
    ["selected", true, false],
    ["lead", false, true],
  ]) {
    await operation({
      action: "save_member",
      member: {
        id: profile,
        profile_id: profile,
        name: profile,
        strengths: "routing",
        enabled: true,
        worker,
        orchestrator,
        planner: orchestrator,
        refiner: false,
        reviewer: false,
        max_sessions: 1,
        priority: 0,
      },
    });
  }
  feature = (
    await operation({
      action: "create_feature",
      title: "Real team routing",
      goal: "Prove selected profile starts Cursor instead of default Claude",
      acceptance: ["Actual session uses Cursor"],
      orchestrator_member: "lead",
      allowed_members: ["selected"],
      max_parallel: 1,
      base_branch: "main",
    })
  ).features[0];
  await operation({
    action: "submit_plan",
    feature_id: feature.id,
    tasks: [
      {
        key: "routing",
        title: "Bounded routing probe",
        instructions:
          "Do not use tools, read or write files. Reply exactly MAESTRO_TEAM_ROUTING_OK and stop.",
        acceptance: ["Reply received"],
        member_id: "selected",
        depends_on: [],
      },
    ],
  });
  // Approval applies only to this explicitly requested acceptance fixture.
  feature = (await operation({ action: "approve_plan", feature_id: feature.id })).features.find(
    (f) => f.id === feature.id,
  );
  const started = await request(
    {
      start_task: {
        project_path: project,
        task_id: feature.task_ids[0],
        role: "Coder",
        unattended: false,
        respect_capacity: true,
      },
    },
    "start_task_ok",
  );
  session = started.session_id;
  console.log(JSON.stringify({ directory, stage: "start_task_accepted", session_id: session }));
  if (!session) throw new Error("Unexpected deferred start");
  const actual = (await next((m) => m.task_session_started?.session_id === session || m.error))
    .task_session_started;
  if (actual?.agent_id !== "cursor")
    throw new Error(`Wrong actual provider: ${JSON.stringify(actual)}`);
  console.log(
    JSON.stringify({
      stage: "actual_session_started",
      agent_id: actual.agent_id,
      session_id: session,
    }),
  );
  const ended = await next(
    (m) => m.turn_ended?.session_id === session || m.error || m.permission_request,
  );
  if (!ended.turn_ended) throw new Error(JSON.stringify(ended));
  const reply = messages
    .filter(
      (m) =>
        m.session_update?.session_id === session &&
        m.session_update.payload?.sessionUpdate === "agent_message_chunk",
    )
    .map((m) => m.session_update.payload.content?.text ?? "")
    .join("");
  const result = {
    directory,
    feature_id: feature.id,
    task_id: feature.task_ids[0],
    session_id: session,
    actual_agent: actual.agent_id,
    project_default_agent: "claude-acp",
    expected_reply: reply.includes("MAESTRO_TEAM_ROUTING_OK"),
    stop_reason: ended.turn_ended.stop_reason,
  };
  writeFileSync(join(directory, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (!result.expected_reply) throw new Error("Provider did not send expected reply");
} catch (error) {
  console.log(JSON.stringify({ directory, error: error.message }, null, 2));
  process.exitCode = 1;
} finally {
  if (session) send({ cancel: { session_id: session } });
  if (feature) {
    try {
      await request(
        {
          orchestration: {
            project_path: project,
            operation: { action: "control", feature_id: feature.id, command: "cancel" },
          },
        },
        "orchestration_ok",
        15_000,
      );
    } catch {
      /* Preserve failed fixture for diagnosis. */
    }
  }
  send({ shutdown: null });
  child.stdin.end();
  await shutdownDaemon(directory);
  await new Promise((done) => {
    if (child.exitCode !== null) return done();
    const timer = setTimeout(() => child.kill(), 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      done();
    });
  });
}
