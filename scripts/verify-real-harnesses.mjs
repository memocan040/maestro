import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";

// Deliberately opt-in: these are real authenticated provider requests, not mocks.
const source = resolve(
  process.env.MAESTRO_HARNESS_TEST_SERVER ?? "target/debug/maestro-server.exe",
);
const directory = mkdtempSync(join(tmpdir(), "maestro-real-harness-"));
const binary = join(
  directory,
  process.platform === "win32" ? "verified-server.exe" : "verified-server",
);
copyFileSync(source, binary);
const agents = process.argv.slice(2);
if (!agents.length)
  throw new Error("Specify installed registry IDs, e.g. codex-acp claude-acp cursor");
const results = [];
for (const agent of agents) {
  const daemonDirectory = join(directory, agent, "daemon");
  mkdirSync(daemonDirectory, { recursive: true });
  const child = spawn(binary, [], {
    cwd: directory,
    env: {
      ...process.env,
      MAESTRO_CUSTOM_DATA_DIR: join(directory, agent),
      MAESTRO_CUSTOM_DAEMON_DIR: daemonDirectory,
    },
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  let buffer = Buffer.alloc(0);
  const waiting = new Set();
  const queued = [];
  const send = (request) => {
    const body = Buffer.from(JSON.stringify({ request }));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    child.stdin.write(Buffer.concat([header, body]));
  };
  const next = (predicate, timeout = 90_000) =>
    new Promise((done, fail) => {
      const index = queued.findIndex(predicate);
      if (index >= 0) return done(queued.splice(index, 1)[0]);
      const item = {
        predicate,
        done: (value) => {
          clearTimeout(timer);
          waiting.delete(item);
          done(value);
        },
        fail,
      };
      const timer = setTimeout(() => {
        waiting.delete(item);
        fail(new Error("Provider timeout"));
      }, timeout);
      waiting.add(item);
    });
  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE() + 4) {
      const size = buffer.readUInt32LE();
      const message = JSON.parse(buffer.subarray(4, size + 4)).response;
      buffer = buffer.subarray(size + 4);
      if (message?.diagnostic || message?.ping) continue;
      let consumed = false;
      for (const item of waiting) {
        if (item.predicate(message)) {
          item.done(message);
          consumed = true;
          break;
        }
      }
      if (!consumed) queued.push(message);
    }
  });
  const sessionId = randomUUID();
  try {
    send({ handshake: { protocol_version: 14 } });
    await next((m) => m.handshake_ok || m.error);
    send({
      spawn: {
        agent_id: agent,
        session_id: sessionId,
        cwd: directory,
        additional_directories: [],
        meta: {},
      },
    });
    const spawned = await next((m) => m.spawn_ok || m.error);
    if (spawned.error) throw new Error(spawned.error.message);
    send({
      prompt: {
        session_id: sessionId,
        content:
          "This is a bounded connectivity test. Do not use tools or read/write files. Reply exactly MAESTRO_CUSTOM_ACP_OK and end your turn.",
      },
    });
    const ended = await next((m) => m.turn_ended || m.error || m.permission_request);
    if (ended.permission_request)
      throw new Error("Unexpected permission request; no tool use approved");
    if (ended.error) throw new Error(ended.error.message);
    const text = queued
      .filter((m) => m.session_update?.payload?.sessionUpdate === "agent_message_chunk")
      .map((m) => m.session_update.payload.content?.text ?? "")
      .join("");
    results.push({
      agent,
      initialized: true,
      prompted: true,
      stop_reason: ended.turn_ended.stop_reason,
      expected_reply: text.includes("MAESTRO_CUSTOM_ACP_OK"),
    });
  } catch (error) {
    send({ cancel: { session_id: sessionId } });
    results.push({ agent, success: false, reason: error.message.slice(0, 300) });
  } finally {
    child.stdin.end();
    await new Promise((done) => {
      if (child.exitCode !== null) return done();
      const timer = setTimeout(() => child.kill(), 5_000);
      child.once("exit", () => {
        clearTimeout(timer);
        done();
      });
    });
  }
}
writeFileSync(join(directory, "results.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify({ directory, results }, null, 2));
if (results.some((r) => !r.expected_reply || r.stop_reason !== "end_turn")) process.exitCode = 1;
