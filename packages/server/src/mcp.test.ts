import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";

import { ResponseEnvelopeSchema } from "@freeplane-mcp/protocol";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { runCodexHostProbe } from "./codexProbe.js";

test("stdio handshake is pinned, clean, and exposes only qualified v0.0A tools", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("packages/server/dist/index.js")],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const client = new Client(
    { name: "freeplane-mcp-contract-test", version: "0.0.0" },
    { supportedProtocolVersions: ["2025-11-25"] },
  );

  try {
    await client.connect(transport);
    assert.equal(client.getNegotiatedProtocolVersion(), "2025-11-25");
    assert.equal(client.getServerVersion()?.name, "freeplane-mcp");

    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      ["freeplane_capabilities", "freeplane_status"],
    );

    const result = await client.callTool({ name: "freeplane_status", arguments: {} });
    assert.equal(result.isError, undefined);
    assert.equal(ResponseEnvelopeSchema.safeParse(result.structuredContent).success, true);
  } finally {
    await client.close();
  }

  assert.equal(stderr, "");
});

test("the local Codex host initializes and calls the pinned stdio server", async () => {
  const result = await runCodexHostProbe();

  assert.equal(result.protocol_revision, "2025-11-25");
  assert.equal(result.server_name, "freeplane-mcp");
  assert.deepEqual(result.tool_names, ["freeplane_capabilities", "freeplane_status"]);
  assert.equal(result.tool_call_verified, true);
});
