import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { BridgeClientError } from "./bridgeClient.js";
import { applyBackupRecovery, inspectBackup, inspectLedger, reconcileLedger } from "./recovery.js";
import { IdempotencyLedger } from "./writeSafety.js";

const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

test("file recovery classifies hashes and requires an explicit hash-bound action", async () => {
  const temporary = await mkdtemp(path.join(await realpath(tmpdir()), "freeplane-mcp-recovery-"));
  const backup = path.join(temporary, "backup");
  const target = path.join(temporary, "map.mm");
  const original = Buffer.from("<map><node ID=\"A\" TEXT=\"before\"/></map>");
  const candidate = Buffer.from("<map><node ID=\"A\" TEXT=\"after\"/></map>");
  try {
    await mkdir(backup, { mode: 0o700 });
    await Promise.all([
      writeFile(path.join(backup, "original.mm"), original, { mode: 0o600 }),
      writeFile(path.join(backup, "candidate.mm"), candidate, { mode: 0o600 }),
      writeFile(path.join(backup, "manifest.json"), JSON.stringify({
        schema_version: 1,
        transaction_id: randomUUID(),
        target_sha256_before: sha256(original),
        candidate_sha256: sha256(candidate),
        node_ids: ["A"],
        status: "prepared",
      }), { mode: 0o600 }),
      writeFile(target, original, { mode: 0o600 }),
    ]);
    await chmod(backup, 0o700);

    assert.equal((await inspectBackup(backup, target)).classification, "original_present");
    const planned = await applyBackupRecovery({
      action: "apply-candidate",
      apply: false,
      backupDirectory: backup,
      target,
      expectedTargetSha256: sha256(original),
    });
    assert.equal(planned.effect, "planned");
    assert.deepEqual(await readFile(target), original);

    const applied = await applyBackupRecovery({
      action: "apply-candidate",
      apply: true,
      backupDirectory: backup,
      target,
      expectedTargetSha256: sha256(original),
    });
    assert.equal(applied.effect, "verified");
    assert.equal(applied.classification, "replacement_committed");
    assert.deepEqual(await readFile(target), candidate);
    await assert.rejects(
      applyBackupRecovery({
        action: "restore-original",
        apply: true,
        backupDirectory: backup,
        target,
        expectedTargetSha256: sha256(original),
      }),
      (error: unknown) => error instanceof BridgeClientError && error.category === "FILE_CONFLICT",
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("pending write evidence survives restart and needs explicit readback reconciliation", async () => {
  const temporary = await mkdtemp(path.join(await realpath(tmpdir()), "freeplane-mcp-ledger-recovery-"));
  const runtime = path.join(temporary, "runtime");
  const key = randomUUID();
  const payload = "a".repeat(64);
  try {
    assert.equal(await new IdempotencyLedger(runtime).claim(key, payload, "bridge-before-crash"), null);
    const restarted = await inspectLedger(runtime);
    assert.equal(restarted.summary.pending, 1);
    assert.equal(restarted.pending[0]?.key, key);
    await assert.rejects(
      new IdempotencyLedger(runtime).claim(randomUUID(), "b".repeat(64), "bridge-after-crash"),
      (error: unknown) => error instanceof BridgeClientError
        && error.category === "IDEMPOTENCY_RECONCILIATION_REQUIRED",
    );
    const readback = "c".repeat(64);
    assert.equal((await reconcileLedger({
      apply: false,
      key,
      payloadSha256: payload,
      readbackSha256: readback,
      runtimeDirectory: runtime,
    })).effect, "planned");
    assert.equal((await inspectLedger(runtime)).summary.pending, 1);
    const reconciled = await reconcileLedger({
      apply: true,
      key,
      payloadSha256: payload,
      readbackSha256: readback,
      runtimeDirectory: runtime,
    });
    assert.equal(reconciled.effect, "verified");
    assert.equal(reconciled.summary.pending, 0);
    assert.equal(reconciled.summary.reconciled, 1);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("pending write evidence does not expire before reconciliation", async () => {
  const temporary = await mkdtemp(path.join(await realpath(tmpdir()), "freeplane-mcp-ledger-aged-"));
  const runtime = path.join(temporary, "runtime");
  const key = randomUUID();
  try {
    await mkdir(runtime, { mode: 0o700 });
    await writeFile(path.join(runtime, "write-state.json"), `${JSON.stringify({
      schema_version: 1,
      entries: [{
        key,
        payload_hash: "a".repeat(64),
        bridge_instance_id: "bridge-before-crash",
        status: "pending",
        created_at: "2000-01-01T00:00:00.000Z",
      }],
    })}\n`, { mode: 0o600 });

    const restarted = await inspectLedger(runtime);
    assert.equal(restarted.summary.pending, 1);
    assert.equal(restarted.pending[0]?.key, key);
    await assert.rejects(
      new IdempotencyLedger(runtime).claim(randomUUID(), "b".repeat(64), "bridge-after-crash"),
      (error: unknown) => error instanceof BridgeClientError
        && error.category === "IDEMPOTENCY_RECONCILIATION_REQUIRED",
    );

    await writeFile(path.join(runtime, "write-state.json"), `${JSON.stringify({
      schema_version: 1,
      entries: [
        {
          key,
          payload_hash: "a".repeat(64),
          bridge_instance_id: "bridge-before-crash",
          status: "pending",
          created_at: "2000-01-01T00:00:00.000Z",
        },
        {
          key,
          payload_hash: "a".repeat(64),
          bridge_instance_id: "bridge-before-crash",
          status: "complete",
          created_at: "2000-01-01T00:00:00.000Z",
          result: {},
        },
      ],
    })}\n`, { mode: 0o600 });
    await assert.rejects(
      inspectLedger(runtime),
      (error: unknown) => error instanceof BridgeClientError && error.category === "RECOVERY_REQUIRED",
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
