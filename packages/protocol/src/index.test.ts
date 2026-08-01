import assert from "node:assert/strict";
import test from "node:test";

import {
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
