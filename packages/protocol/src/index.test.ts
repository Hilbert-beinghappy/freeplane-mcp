import assert from "node:assert/strict";
import test from "node:test";

import {
  ApplyInputSchema,
  ChangesInputSchema,
  DocumentInputSchema,
  ERROR_CATEGORIES,
  ExportInputSchema,
  ReadInputSchema,
  ResponseEnvelopeSchema,
  SearchInputSchema,
  TOOL_NAMES,
  ViewInputSchema,
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

test("v0.3 atomic edit union accepts the qualified core and knowledge-map operations", () => {
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
    { op: "clone_node", temp_id: "$clone", source_id: "A", parent_id: "ROOT", index: 0, with_subtree: false },
    { op: "create_summary", temp_id: "$summary", parent_id: "ROOT", first_child_id: "A", last_child_id: "B", text: "summary" },
    { op: "set_free", node_id: "A", free: true },
    { op: "set_side", node_id: "A", side: "LEFT" },
    { op: "set_style", node_id: "A", style: { background_color: "#123456", bold: true, font_size: 18 } },
    { op: "set_layout", node_id: "A", layout: { child_nodes: "AUTO", horizontal_shift: 12 } },
    { op: "set_cloud", node_id: "A", enabled: true, shape: "ARC", color: "#ABCDEF" },
    { op: "set_bookmark", node_id: "A", bookmark: { action: "set", name: "evidence", type: "SELECT" } },
    { op: "set_formula", node_id: "A", expression: "=(365 + 365) / 2" },
    { op: "set_reminder", node_id: "A", reminder: { action: "set", at: "2030-01-01T00:00:00.000Z", period_unit: "YEAR", period: 1 } },
  ];
  for (const operation of operations) {
    assert.equal(ApplyInputSchema.safeParse({ ...base, operations: [operation] }).success, true, operation.op);
  }
  assert.equal(ApplyInputSchema.safeParse({ ...base, operations: [{ op: "update_content", node_id: "A" }] }).success, false);
  assert.equal(ApplyInputSchema.safeParse({ ...base, operations: [{ op: "set_style", node_id: "A", style: {} }] }).success, false);
  assert.equal(ApplyInputSchema.safeParse({ ...base, operations: [{ op: "set_formula", node_id: "A", expression: "=node.text" }] }).success, false);
  assert.equal(ApplyInputSchema.safeParse({ ...base, operations: [{ op: "clone_node", temp_id: "$x", source_id: "A", parent_id: "ROOT", index: 0, with_subtree: true }] }).success, false);
  assert.equal(ApplyInputSchema.safeParse({ ...base, operations: [operations[0]], confirmation: true }).success, false);
  assert.equal(ApplyInputSchema.safeParse({ ...base, idempotency_key: "not-a-uuid", operations: [operations[0]] }).success, false);
});

test("v0.3 view contract allows literal filtering only", () => {
  assert.equal(ViewInputSchema.safeParse({
    action: "apply_filter",
    map_id: "map",
    expected_view_revision: 2,
    query: { mode: "literal", value: "validation" },
  }).success, true);
  assert.equal(ViewInputSchema.safeParse({
    action: "apply_filter",
    map_id: "map",
    expected_view_revision: 2,
    query: { mode: "regex", value: ".*" },
  }).success, false);
  assert.equal(ViewInputSchema.safeParse({
    action: "clear_filter",
    map_id: "map",
    expected_view_revision: 2,
    query: { mode: "literal", value: "ignored" },
  }).success, false);
});

test("v0.4 document and export contracts keep paths, revisions, and formats explicit", () => {
  const idempotency_key = "a8bfce4e-9f3d-4d5d-a63a-c37f4b993202";
  assert.equal(DocumentInputSchema.safeParse({ action: "create", idempotency_key }).success, true);
  assert.equal(DocumentInputSchema.safeParse({
    action: "save_as",
    map_id: "map",
    path: "/tmp/map.mm",
    expected_content_revision: 4,
    expected_file_revision: null,
    idempotency_key,
  }).success, true);
  assert.equal(DocumentInputSchema.safeParse({ action: "open", path: "relative.mm", idempotency_key }).success, false);
  assert.equal(DocumentInputSchema.safeParse({
    action: "close",
    map_id: "map",
    close_mode: "discard",
    expected_content_revision: 4,
    idempotency_key,
  }).success, false);
  assert.equal(ExportInputSchema.safeParse({
    map_id: "map",
    format_id: "pdf",
    destination: "/tmp/map.pdf",
    expected_content_revision: 4,
    idempotency_key,
  }).success, true);
  assert.equal(ExportInputSchema.safeParse({
    map_id: "map",
    scope: "selection",
    format_id: "docx",
    destination: "/tmp/map.docx",
    expected_content_revision: 4,
    idempotency_key,
  }).success, false);
});
