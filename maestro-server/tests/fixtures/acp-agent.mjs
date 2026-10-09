import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

const lines = createInterface({ input: process.stdin });
const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === "initialize") {
    send({
      id: request.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        authMethods: [],
        agentInfo: { name: "Deterministic fixture", version: "1" },
      },
    });
  } else if (request.method === "session/new") {
    send({ id: request.id, result: { sessionId: randomUUID() } });
  } else if (request.method === "session/load" || request.method === "session/close") {
    send({ id: request.id, result: {} });
  } else if (request.method === "session/prompt") {
    send({
      method: "session/update",
      params: {
        sessionId: request.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "MAESTRO_CUSTOM_ACP_OK" },
        },
      },
    });
    send({ id: request.id, result: { stopReason: "end_turn" } });
  } else {
    send({ id: request.id, error: { code: -32601, message: "Unsupported fixture method" } });
  }
});
