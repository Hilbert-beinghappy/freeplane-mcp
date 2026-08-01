import assert from "node:assert/strict";
import test from "node:test";
import { homedir } from "node:os";
import path from "node:path";

import { axHelperConfig, invokeAxHelper, probeAxHelper } from "./axHelper.js";
import { BridgeClientError } from "./bridgeClient.js";

const builtHelper = path.join(
  homedir(),
  "Library/Caches/Freeplane-MCP/ax-helper/v1.0/freeplane-mcp-ax-helper",
);

test("signed Accessibility helper reports a bounded local status", async () => {
  const status = await probeAxHelper(axHelperConfig({ FREEPLANE_MCP_AX_HELPER: builtHelper }));
  assert.equal(status.available, true);
  assert.equal(status.helper_version, "1.0.0");
  assert.match(status.permission, /^(granted|denied)$/);
});

test("Accessibility helper binds invocation to the qualified Freeplane bundle", async () => {
  await assert.rejects(
    invokeAxHelper(axHelperConfig({ FREEPLANE_MCP_AX_HELPER: builtHelper }), {
      schema_version: 1,
      command: "invoke",
      pid: process.pid,
      expected_locale: "en",
      capability_id: "print.preview",
      action: "open",
      dry_run: true,
    }),
    (error: unknown) => error instanceof BridgeClientError
      && ["ACTION_PRECONDITION_FAILED", "POLICY_DENIED"].includes(error.category),
  );
});

test("missing Accessibility helper stays unavailable without executing a fallback", async () => {
  const status = await probeAxHelper(axHelperConfig({ FREEPLANE_MCP_AX_HELPER: "/missing/freeplane-mcp-ax-helper" }));
  assert.deepEqual(status, { available: false, permission: "unavailable", helper_version: null });
});
