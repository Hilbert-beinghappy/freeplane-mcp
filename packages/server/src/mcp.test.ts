import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ResponseEnvelopeSchema } from "@freeplane-mcp/protocol";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";

import { runCodexHostProbe } from "./codexProbe.js";
import { BridgeClientError, readBoundedResponseText } from "./bridgeClient.js";

const EXPECTED_TOOLS = [
  "freeplane_apply",
  "freeplane_capabilities",
  "freeplane_changes",
  "freeplane_history",
  "freeplane_list_maps",
  "freeplane_read",
  "freeplane_search",
  "freeplane_status",
];

test("bridge response streaming stops at the configured byte ceiling", async () => {
  assert.equal(await readBoundedResponseText(new Response("1234"), 4), "1234");
  await assert.rejects(
    readBoundedResponseText(new Response("1234"), 3),
    (error: unknown) => error instanceof BridgeClientError && error.category === "LIMIT_EXCEEDED",
  );
});

test("stdio handshake is pinned, clean, and exposes only qualified v0.2 tools", async () => {
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
      EXPECTED_TOOLS,
    );

    const result = await client.callTool({ name: "freeplane_status", arguments: {} });
    assert.equal(result.isError, undefined);
    const status = ResponseEnvelopeSchema.parse(result.structuredContent);
    assert.equal(status.authority, "file");
    assert.equal(status.route?.kind, "internal_api");
    const statusData = status.data as {
      degraded?: boolean;
      qualification_report?: string;
      qualification_passed?: boolean;
    };
    assert.equal(statusData.degraded, true);
    assert.match(statusData.qualification_report ?? "", /^v0\.2-/);
    assert.equal(statusData.qualification_passed, true);

    const capabilities = ResponseEnvelopeSchema.parse((await client.callTool({
      name: "freeplane_capabilities",
      arguments: {},
    })).structuredContent);
    assert.equal(capabilities.route?.kind, "internal_api");
    const capabilityData = capabilities.data as {
      capabilities: Array<{ capability_id: string; available_via_mcp: boolean }>;
    };
    assert.equal(capabilityData.capabilities.find((item) => item.capability_id === "map.read")?.available_via_mcp, true);
    assert.equal(
      capabilityData.capabilities.find((item) => item.capability_id === "node.update_text")?.available_via_mcp,
      true,
    );
  } finally {
    await client.close();
  }

  assert.equal(stderr, "");
});

test("saved-file degradation lists, paginates, reads, and searches without claiming unsaved state", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "freeplane-mcp-mcp-test-"));
  const fixture = path.join(temporary, "fallback.mm");
  await writeFile(fixture, `<?xml version="1.0" encoding="UTF-8"?>
<map><node ID="ROOT" TEXT="root"><attribute NAME="x" VALUE="1"/><attribute NAME="x" VALUE="2"/><node ID="CHILD" TEXT="search target"/></node></map>`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("packages/server/dist/index.js")],
    cwd: process.cwd(),
    env: {
      ...getDefaultEnvironment(),
      FREEPLANE_MCP_RUNTIME_DIR: path.join(temporary, "missing-runtime"),
      FREEPLANE_MCP_FILES: JSON.stringify([fixture]),
      FREEPLANE_MCP_ALLOWED_ROOTS: JSON.stringify([temporary]),
    },
    stderr: "pipe",
  });
  const client = new Client(
    { name: "freeplane-mcp-file-test", version: "0.1.0" },
    { supportedProtocolVersions: ["2025-11-25"] },
  );

  try {
    await client.connect(transport);
    const listed = ResponseEnvelopeSchema.parse((await client.callTool({
      name: "freeplane_list_maps",
      arguments: {},
    })).structuredContent);
    assert.equal(listed.authority, "file");
    const mapId = (listed.data as { maps: Array<{ map_id: string }> }).maps[0]?.map_id;
    assert.match(mapId ?? "", /^file:[a-f0-9]{64}$/);

    const first = ResponseEnvelopeSchema.parse((await client.callTool({
      name: "freeplane_read",
      arguments: { map_id: mapId, scope: "map", depth: 10, max_nodes: 1, fields: ["text", "attributes"] },
    })).structuredContent);
    assert.equal(first.authority, "file");
    const firstData = first.data as {
      unsaved_visibility: boolean;
      nodes: Array<{ attributes: Array<{ name: string; value: string }> }>;
      page: { next_cursor: string };
    };
    assert.equal(firstData.unsaved_visibility, false);
    assert.deepEqual(firstData.nodes[0]?.attributes, [
      { name: "x", value: "1" },
      { name: "x", value: "2" },
    ]);

    const second = ResponseEnvelopeSchema.parse((await client.callTool({
      name: "freeplane_read",
      arguments: {
        map_id: mapId,
        scope: "map",
        depth: 10,
        max_nodes: 1,
        fields: ["text", "attributes"],
        page_cursor: firstData.page.next_cursor,
      },
    })).structuredContent);
    assert.equal((second.data as { nodes: Array<{ node_id: string }> }).nodes[0]?.node_id, "CHILD");

    const searched = ResponseEnvelopeSchema.parse((await client.callTool({
      name: "freeplane_search",
      arguments: {
        map_id: mapId,
        query: { text: { mode: "literal", value: "TARGET", case_sensitive: false } },
      },
    })).structuredContent);
    assert.equal(searched.route?.capability_id, "map.search.literal");
    assert.equal((searched.data as { matches: Array<{ node_id: string }> }).matches[0]?.node_id, "CHILD");

    const changes = await client.callTool({ name: "freeplane_changes", arguments: {} });
    assert.equal(changes.isError, true);
    const changesEnvelope = ResponseEnvelopeSchema.parse(changes.structuredContent);
    assert.equal(changesEnvelope.error?.category, "BRIDGE_UNAVAILABLE");
    assert.equal(changesEnvelope.route, null);
  } finally {
    await client.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("the local Codex host initializes and calls the pinned stdio server", async () => {
  const result = await runCodexHostProbe();

  assert.equal(result.protocol_revision, "2025-11-25");
  assert.equal(result.server_name, "freeplane-mcp");
  assert.deepEqual(result.tool_names, EXPECTED_TOOLS);
  assert.equal(result.tool_call_verified, true);
});
