import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ResponseEnvelopeSchema, emptyEvidence, type ApplyInput } from "@freeplane-mcp/protocol";

import { BridgeClientError } from "./bridgeClient.js";
import {
  ConfirmationStore,
  IdempotencyLedger,
  applyPayloadHash,
  compileOperations,
  operationHash,
  operationRisk,
} from "./writeSafety.js";

const apply: ApplyInput = {
  map_id: "map",
  expected_content_revision: 1,
  expected_view_revision: null,
  idempotency_key: "a8bfce4e-9f3d-4d5d-a63a-c37f4b993202",
  dry_run: false,
  operations: [
    { op: "create_node", temp_id: "$new", parent_id: "ROOT", index: 0, content: { text: "secret text", note: "secret note" } },
    { op: "delete_nodes", node_ids: ["OLD"] },
  ],
  confirmation: null,
  user_summary: "edit",
};

const result = ResponseEnvelopeSchema.parse({
  ok: true,
  effect_status: "verified",
  authority: "bridge",
  bridge_instance_id: "bridge-1",
  map_id: "map",
  before: { content_revision: 1, view_revision: 0 },
  after: { content_revision: 2, view_revision: 0 },
  route: { kind: "internal_api", capability_id: "transaction.atomic_compound_undo", validation_status: "verified_internal_api" },
  data: { transaction_id: "tx" },
  evidence: emptyEvidence(),
  warnings: [],
  error: null,
});

test("v0.2 operation compiler is narrow and risk classification is conservative", () => {
  const compiled = compileOperations(apply.operations);
  assert.deepEqual(compiled.slice(0, 3), [
    { type: "create_child", temp_id: "$new", parent: "ROOT", position: 0, text: "secret text" },
    { type: "set_note", node: "$new", value: "secret note" },
    { type: "delete_node", node: "OLD" },
  ]);
  assert.deepEqual(operationRisk(apply.operations), {
    risk: "confirm",
    effects: [{ kind: "delete_nodes", count: 1 }],
    estimatedAffectedNodes: 2,
  });
  assert.equal(applyPayloadHash(apply), applyPayloadHash({ ...apply, confirmation: {
    confirmation_id: "fpconfirm:test",
    accepted: true,
  } }));
});

test("confirmation is one-time and bound to bridge, map, revisions, and operations", () => {
  const store = new ConfirmationStore();
  const binding = {
    bridgeInstanceId: "bridge-1",
    mapId: "map",
    contentRevision: 1,
    viewRevision: 2,
    operationHash: operationHash(apply.operations),
  };
  const challenge = store.issue(binding, {
    planId: "plan",
    planHash: "a".repeat(64),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, [{ kind: "delete_nodes", count: 1 }]);
  assert.equal(store.consume(challenge.confirmation_id, binding).planId, "plan");
  assert.throws(
    () => store.consume(challenge.confirmation_id, binding),
    (error: unknown) => error instanceof BridgeClientError && error.category === "CONFIRMATION_EXPIRED",
  );

  const stale = store.issue(binding, {
    planId: "plan-2",
    planHash: "b".repeat(64),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, [{ kind: "delete_nodes", count: 1 }]);
  assert.throws(
    () => store.consume(stale.confirmation_id, { ...binding, viewRevision: 3 }),
    (error: unknown) => error instanceof BridgeClientError && error.category === "CONFIRMATION_STALE",
  );
});

test("idempotency ledger is atomic, private, bounded to a bridge instance, and stores no request content", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "freeplane-mcp-ledger-"));
  const runtime = path.join(temporary, "runtime");
  const key = apply.idempotency_key;
  const hash = applyPayloadHash(apply);
  try {
    const ledger = new IdempotencyLedger(runtime);
    assert.equal(await ledger.claim(key, hash, "bridge-1"), null);
    await ledger.settle(key, result);
    assert.deepEqual(await ledger.claim(key, hash, "bridge-1"), result);
    await assert.rejects(
      ledger.claim(key, "b".repeat(64), "bridge-1"),
      (error: unknown) => error instanceof BridgeClientError && error.category === "IDEMPOTENCY_KEY_REUSED",
    );
    await assert.rejects(
      ledger.claim(key, hash, "bridge-2"),
      (error: unknown) => error instanceof BridgeClientError && error.category === "IDEMPOTENCY_RECONCILIATION_REQUIRED",
    );
    const statePath = path.join(runtime, "write-state.json");
    assert.equal((await stat(runtime)).mode & 0o777, 0o700);
    assert.equal((await stat(statePath)).mode & 0o777, 0o600);
    const state = await readFile(statePath, "utf8");
    assert.equal(state.includes("secret text"), false);
    assert.equal(state.includes("secret note"), false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
