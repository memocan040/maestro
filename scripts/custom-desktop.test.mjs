import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { daemonRequest } from "./custom-desktop.mjs";

function frame(response) {
  const body = Buffer.from(JSON.stringify({ response }));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

async function fixture(t, answer, expectedRequest = { home_summary: { project_paths: [] } }) {
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let attached = false;
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!attached) {
        const prefix = "test-secret\nATTACH\n";
        if (buffer.length < prefix.length) return;
        assert.equal(buffer.subarray(0, prefix.length).toString(), prefix);
        buffer = buffer.subarray(prefix.length);
        attached = true;
      }
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE() + 4) {
        const size = buffer.readUInt32LE();
        const request = JSON.parse(buffer.subarray(4, size + 4)).request;
        buffer = buffer.subarray(size + 4);
        if (request.handshake) {
          assert.equal(request.handshake.protocol_version, 14);
          const response = frame({ handshake_ok: { protocol_version: 14 } });
          socket.write(response.subarray(0, 2));
          setTimeout(() => socket.write(response.subarray(2)), 5);
        } else {
          assert.deepEqual(request, expectedRequest);
          answer(socket);
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { port: server.address().port, token: "test-secret", protocol_version: 14 };
}

test("authenticated little-endian framing accepts fragmented replies and ignores pushes", async (t) => {
  const runtime = await fixture(t, (socket) => {
    socket.write(frame({ orchestration_changed: {} }));
    socket.end(frame({ home_summary_ok: { status: { live_sessions: 2, running_runs: 1 } } }));
  });
  assert.deepEqual(await daemonRequest(runtime, { home_summary: { project_paths: [] } }), {
    live_sessions: 2,
    running_runs: 1,
  });
});

test("daemon errors prevent unsafe zero-session assumptions", async (t) => {
  const runtime = await fixture(t, (socket) => socket.end(frame({ error: { message: "Denied" } })));
  await assert.rejects(daemonRequest(runtime, { home_summary: { project_paths: [] } }), /Denied/);
});

test("connection loss is an error, not a safe restart", async (t) => {
  const runtime = await fixture(t, (socket) => socket.end());
  await assert.rejects(
    daemonRequest(runtime, { home_summary: { project_paths: [] } }),
    /geschlossen/,
  );
});

test("oversized replies are rejected before buffering their bodies", async (t) => {
  const runtime = await fixture(t, (socket) => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(16 * 1024 * 1024 + 1);
    socket.end(header);
  });
  await assert.rejects(daemonRequest(runtime, { home_summary: { project_paths: [] } }), /Frame/);
});

test("continuous pushes cannot extend the absolute request deadline", async (t) => {
  const runtime = await fixture(t, (socket) => {
    const timer = setInterval(() => socket.write(frame({ orchestration_changed: {} })), 10);
    socket.once("close", () => clearInterval(timer));
  });
  await assert.rejects(
    daemonRequest(runtime, { home_summary: { project_paths: [] } }, "home_summary_ok", 150),
    /antwortet nicht/,
  );
});

test("orchestration replies retain the snapshot payload", async (t) => {
  const request = { orchestration: { project_path: "fixture", operation: { action: "snapshot" } } };
  const snapshot = {
    members: [],
    features: [{ id: "f1", status: "AwaitingApproval" }],
    messages: [],
  };
  const runtime = await fixture(
    t,
    (socket) => socket.end(frame({ orchestration_ok: snapshot })),
    request,
  );
  assert.deepEqual(await daemonRequest(runtime, request, "orchestration_ok"), snapshot);
});
