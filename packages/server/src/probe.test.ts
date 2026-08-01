import assert from "node:assert/strict";
import test from "node:test";

import { runProbe } from "./probe.js";

test("the installed Freeplane build passes the frozen v0.0A surface probe", async () => {
  const { report, manifest } = await runProbe({ now: new Date("2026-08-01T00:00:00.000Z") });

  assert.deepEqual(
    report.checks.filter(
      (check) => check.status === "fail" && check.id !== "protocol.codex_stdio_handshake",
    ),
    [],
  );
  assert.equal(report.freeplane.version, "1.13.3");
  assert.equal(report.freeplane.bundled_java_version, "21.0.11");
  assert.equal(report.menu_inventory.entry_count, 1142);
  assert.equal(report.menu_inventory.unique_action_count, 381);
  assert.equal(report.builtin_mcp.token_observed, false);
  assert.equal(manifest.capabilities.some((capability) => capability.status.startsWith("verified_")), false);
});
