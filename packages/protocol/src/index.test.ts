import assert from "node:assert/strict";
import test from "node:test";

import {
  ApplyInputSchema,
  ChangesInputSchema,
  ERROR_CATEGORIES,
  ReadInputSchema,
  ResponseEnvelopeSchema,
  SearchInputSchema,
  TOOL_NAMES,
  emptyEvidence,
} from "./index.js";

test("the frozen error and tool registries contain no duplicates", () => {
  assert.equal(new Set(ERROR_CATEGORIES).size, ERROR_CATEGORIES.length);
  assert.equal(new Set(TOOL_NAMES).size, TOOL_NAMES.length);
  assert.equal(TOOL_NAMES.length, 12);
});

test("response envelope keeps success and error states consistent", () => {
  const valid = {
    ok: true,
    effect_status: "none",
    authority: "file",
    bridge_instance_id: null,
    map_id: null,
    before: null,
    after: null,
    route: null,
    data: {},
    evidence: emptyEvidence(),
    warnings: [],
    error: null,
  };

  assert.equal(ResponseEnvelopeSchema.safeParse(valid).success, true);
  assert.equal(
    ResponseEnvelopeSchema.safeParse({
      ...valid,
      ok: false,
      error: null,
    }).success,
    false,
  );
  assert.equal(
    ResponseEnvelopeSchema.safeParse({
      ...valid,
      error: { category: "BRIDGE_UNAVAILABLE", message: "offline" },
    }).success,
    false,
  );
});

test("v0.1 read-only inputs are bounded and reject unqualified search modes", () => {
  assert.equal(ReadInputSchema.safeParse({ map_id: "map", scope: "map" }).success, true);
  assert.equal(ReadInputSchema.safeParse({ scope: "map" }).success, false);
  assert.equal(ReadInputSchema.safeParse({ map_id: "map", scope: "nodes", node_ids: [] }).success, false);
  assert.equal(ReadInputSchema.safeParse({ map_id: "map", include_effective_style: true }).success, false);
  assert.equal(
    SearchInputSchema.safeParse({
      map_id: "map",
      query: { text: { mode: "regex", value: ".*" } },
    }).success,
    false,
  );
  assert.equal(ChangesInputSchema.safeParse({ wait_ms: 751 }).success, false);
});

test("v0.2 atomic edit union accepts only the qualified core operations", () => {
  const base = {
    map_id: "map",
    expected_content_revision: 4,
    idempotency_key: "a8bfce4e-9f3d-4d5d-a63a-c37f4b993202",
    dry_run: true,
    user_summary: "core edit",
  };
  const operations = [
    { op: "create_node", temp_id: "$new1", parent_id: "ROOT", index: 0, content: { text: "child" } },
    { op: "update_content", node_id: "$new1", text: "text", details: "details", note: "note" },
    { op: "set_attributes", node_id: "$new1", attributes: [{ name: "key", value: "value" }] },
    { op: "set_tags", node_id: "$new1", tags: ["tag"] },
    { op: "set_icons", node_id: "$new1", icons: ["button_ok"] },
    { op: "set_link", node_id: "$new1", link: { kind: "uri", uri: "https://example.com" } },
    { op: "move_node", node_id: "$new1", parent_id: "ROOT", index: 0 },
    { op: "reorder_children", parent_id: "ROOT", child_ids: ["$new1"] },
    { op: "delete_nodes", node_ids: ["$new1"] },
    { op: "set_folded", node_id: "ROOT", folded: true },
    { op: "add_connector", source_id: "A", target_id: "B", properties: { shape: "LINE" } },
    { op: "update_connector", connector_id: `fpconn:${"a".repeat(64)}`, properties: { width: 2 } },
    { op: "remove_connector", connector_ids: [`fpconn:${"b".repeat(64)}`] },
  ];
  for (const operation of operations) {
    assert.equal(ApplyInputSchema.safeParse({ ...base, operations: [operation] }).success, true, operation.op);
  }
  assert.equal(ApplyInputSchema.safeParse({ ...base, operations: [{ op: "update_content", node_id: "A" }] }).success, false);
  assert.equal(ApplyInputSchema.safeParse({ ...base, operations: [{ op: "set_style", node_id: "A" }] }).success, false);
  assert.equal(ApplyInputSchema.safeParse({ ...base, operations: [operations[0]], confirmation: true }).success, false);
  assert.equal(ApplyInputSchema.safeParse({ ...base, idempotency_key: "not-a-uuid", operations: [operations[0]] }).success, false);
});
