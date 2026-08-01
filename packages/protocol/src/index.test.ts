import assert from "node:assert/strict";
import test from "node:test";

import {
  ERROR_CATEGORIES,
  ResponseEnvelopeSchema,
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
