import { spawn, execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { createInterface } from "node:readline";

// Official binary only. Does not authenticate, import accounts, grant tools, or print secrets.
const cwd = mkdtempSync(join(tmpdir(), "maestro-agy-acp-"));
const binary = join(
  homedir(),
  ".maestro-custom",
  "agent-binaries",
  "antigravity-acp",
  "1.3.0",
  "agy_acp_server.exe",
);
const child = spawn(binary, [], { cwd, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
let sequence = 0;
const pending = new Map();
createInterface({ input: child.stdout }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (pending.has(message.id)) pending.get(message.id)(message);
  else if (message.id !== undefined)
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Tools are not enabled for this probe" },
      }) + "\n",
    );
});
const request = (method, params) =>
  new Promise((done, fail) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      fail(new Error(`${method} timed out`));
    }, 30_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      pending.delete(id);
      done(message);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
try {
  const initialized = await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "maestro-custom-verification", version: "0.35.1" },
  });
  if (initialized.error) throw new Error(JSON.stringify(initialized.error));
  const result = initialized.result;
  console.log(
    JSON.stringify(
      {
        binary,
        initialize: "passed",
        agentInfo: result.agentInfo,
        capabilities: result.agentCapabilities,
        authMethods: result.authMethods?.map(({ id, name }) => ({ id, name })),
      },
      null,
      2,
    ),
  );
  const session = await request("session/new", { cwd, mcpServers: [] });
  if (session.error) {
    console.log(JSON.stringify({ session_new: "blocked", error: session.error }, null, 2));
    process.exitCode = 1;
  } else {
    console.log(
      JSON.stringify(
        {
          session_new: "passed",
          session_id: session.result.sessionId,
          models: session.result.models,
          modes: session.result.modes,
        },
        null,
        2,
      ),
    );
    const prompt = await request("session/prompt", {
      sessionId: session.result.sessionId,
      prompt: [
        { type: "text", text: "Do not use tools. Reply exactly MAESTRO_CUSTOM_ACP_OK and stop." },
      ],
    });
    console.log(
      JSON.stringify(
        {
          prompt: prompt.error ? "blocked" : "passed",
          error: prompt.error,
          stop_reason: prompt.result?.stopReason,
        },
        null,
        2,
      ),
    );
    if (prompt.error) process.exitCode = 1;
  }
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
} finally {
  child.stdin.end();
  await new Promise((done) => {
    if (child.exitCode !== null) return done();
    const timer = setTimeout(() => {
      if (process.platform === "win32") {
        try {
          execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          });
        } catch {
          child.kill();
        }
      } else child.kill();
    }, 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      done();
    });
  });
  child.stdout.destroy();
}
