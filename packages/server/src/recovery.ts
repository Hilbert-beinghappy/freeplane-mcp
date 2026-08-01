import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { BridgeClientError } from "./bridgeClient.js";
import { IdempotencyLedger } from "./writeSafety.js";

const execFile = promisify(execFileCallback);
const SHA256 = /^[a-f0-9]{64}$/;

type RecoveryAction = "restore-original" | "apply-candidate";

interface BackupEvidence {
  kind: "map" | "artifact";
  backupDirectory: string;
  originalPath: string;
  originalSha256: string;
  candidatePath: string | null;
  candidateSha256: string;
}

export interface BackupInspection {
  schema_version: 1;
  kind: "map" | "artifact";
  classification: "original_present" | "replacement_committed" | "target_missing" | "indeterminate";
  target_sha256: string | null;
  original_sha256: string;
  candidate_sha256: string;
  evidence_valid: boolean;
  available_actions: RecoveryAction[];
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactAbsolute(value: string, label: string): string {
  if (!path.isAbsolute(value) || path.normalize(value) !== value || value === path.parse(value).root) {
    throw new BridgeClientError("VALIDATION_ERROR", `${label} must be a normalized absolute path`, {}, 400);
  }
  return value;
}

async function privateRegularBytes(target: string, maximum: number): Promise<Buffer> {
  const entry = await lstat(target).catch(() => null);
  if (
    !entry?.isFile()
    || entry.isSymbolicLink()
    || entry.size > maximum
    || (entry.mode & 0o022) !== 0
    || (typeof process.getuid === "function" && entry.uid !== process.getuid())
  ) {
    throw new BridgeClientError("RECOVERY_REQUIRED", "Recovery evidence has unsafe metadata", {}, 409);
  }
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function targetBytes(target: string): Promise<Buffer | null> {
  const entry = await lstat(target).catch(() => null);
  if (!entry) return null;
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 512 * 1024 * 1024) {
    throw new BridgeClientError("RECOVERY_REQUIRED", "Recovery target must be a bounded regular file", {}, 409);
  }
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BridgeClientError("RECOVERY_REQUIRED", "Backup manifest is invalid", {}, 409);
  }
  return value as Record<string, unknown>;
}

async function readEvidence(backupDirectoryValue: string): Promise<BackupEvidence> {
  const backupDirectory = exactAbsolute(backupDirectoryValue, "backup directory");
  const directory = await lstat(backupDirectory).catch(() => null);
  if (
    !directory?.isDirectory()
    || directory.isSymbolicLink()
    || (directory.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && directory.uid !== process.getuid())
  ) {
    throw new BridgeClientError("RECOVERY_REQUIRED", "Backup directory has unsafe metadata", {}, 409);
  }
  const manifest = objectValue(JSON.parse((await privateRegularBytes(
    path.join(backupDirectory, "manifest.json"),
    64 * 1024,
  )).toString("utf8")));
  if (manifest.schema_version !== 1 || typeof manifest.target_sha256_before !== "string"
      || !SHA256.test(manifest.target_sha256_before)) {
    throw new BridgeClientError("RECOVERY_REQUIRED", "Backup manifest schema is invalid", {}, 409);
  }
  if (typeof manifest.candidate_sha256 === "string" && SHA256.test(manifest.candidate_sha256)) {
    const originalPath = path.join(backupDirectory, "original.mm");
    const candidatePath = path.join(backupDirectory, "candidate.mm");
    return {
      kind: "map",
      backupDirectory,
      originalPath,
      originalSha256: manifest.target_sha256_before,
      candidatePath,
      candidateSha256: manifest.candidate_sha256,
    };
  }
  if (typeof manifest.replacement_sha256 === "string" && SHA256.test(manifest.replacement_sha256)
      && typeof manifest.format === "string" && /^[a-z0-9]{2,8}$/.test(manifest.format)) {
    return {
      kind: "artifact",
      backupDirectory,
      originalPath: path.join(backupDirectory, `original.${manifest.format}`),
      originalSha256: manifest.target_sha256_before,
      candidatePath: null,
      candidateSha256: manifest.replacement_sha256,
    };
  }
  throw new BridgeClientError("RECOVERY_REQUIRED", "Backup manifest does not describe a supported recovery pair", {}, 409);
}

async function verifiedEvidence(backupDirectory: string): Promise<{
  evidence: BackupEvidence;
  original: Buffer;
  candidate: Buffer | null;
}> {
  const evidence = await readEvidence(backupDirectory);
  const original = await privateRegularBytes(evidence.originalPath, 512 * 1024 * 1024);
  const candidate = evidence.candidatePath
    ? await privateRegularBytes(evidence.candidatePath, 512 * 1024 * 1024)
    : null;
  if (digest(original) !== evidence.originalSha256
      || (candidate !== null && digest(candidate) !== evidence.candidateSha256)) {
    throw new BridgeClientError("RECOVERY_REQUIRED", "Backup evidence hash verification failed", {}, 409);
  }
  return { evidence, original, candidate };
}

export async function inspectBackup(backupDirectory: string, targetValue: string): Promise<BackupInspection> {
  const target = exactAbsolute(targetValue, "target");
  const { evidence } = await verifiedEvidence(backupDirectory);
  const current = await targetBytes(target);
  const targetSha256 = current === null ? null : digest(current);
  const classification = targetSha256 === null
    ? "target_missing"
    : targetSha256 === evidence.originalSha256
      ? "original_present"
      : targetSha256 === evidence.candidateSha256
        ? "replacement_committed"
        : "indeterminate";
  return {
    schema_version: 1,
    kind: evidence.kind,
    classification,
    target_sha256: targetSha256,
    original_sha256: evidence.originalSha256,
    candidate_sha256: evidence.candidateSha256,
    evidence_valid: true,
    available_actions: evidence.candidatePath ? ["restore-original", "apply-candidate"] : ["restore-original"],
  };
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function applyBackupRecovery(options: {
  action: RecoveryAction;
  apply: boolean;
  backupDirectory: string;
  expectedTargetSha256: string | "missing";
  target: string;
}): Promise<BackupInspection & { effect: "planned" | "verified"; preserved_target_sha256: string | null }> {
  const target = exactAbsolute(options.target, "target");
  if (options.expectedTargetSha256 !== "missing" && !SHA256.test(options.expectedTargetSha256)) {
    throw new BridgeClientError("VALIDATION_ERROR", "expected target hash must be lowercase SHA-256 or missing", {}, 400);
  }
  const verified = await verifiedEvidence(options.backupDirectory);
  const source = options.action === "restore-original" ? verified.original : verified.candidate;
  if (!source) throw new BridgeClientError("CAPABILITY_UNAVAILABLE", "This backup has no retained candidate", {}, 409);
  const before = await targetBytes(target);
  const beforeSha256 = before === null ? null : digest(before);
  const expected = options.expectedTargetSha256 === "missing" ? null : options.expectedTargetSha256;
  if (beforeSha256 !== expected) {
    throw new BridgeClientError("FILE_CONFLICT", "Recovery target changed after inspection", {}, 409);
  }
  if (!options.apply) {
    const inspection = await inspectBackup(options.backupDirectory, target);
    return { ...inspection, effect: "planned", preserved_target_sha256: beforeSha256 };
  }

  const parent = path.dirname(target);
  if (await realpath(parent) !== parent) {
    throw new BridgeClientError("PATH_DENIED", "Recovery target parent contains a symlink", {}, 403);
  }
  if (before !== null) {
    const preserved = path.join(verified.evidence.backupDirectory, `pre-recovery-${beforeSha256}.bin`);
    const existing = await lstat(preserved).catch(() => null);
    if (!existing) {
      const handle = await open(
        preserved,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      try {
        await handle.write(before);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fsyncDirectory(verified.evidence.backupDirectory);
    } else if (!existing.isFile() || digest(await privateRegularBytes(preserved, 512 * 1024 * 1024)) !== beforeSha256) {
      throw new BridgeClientError("RECOVERY_REQUIRED", "Preserved pre-recovery target conflicts with existing evidence", {}, 409);
    }
  }

  const temporary = path.join(parent, `.${path.basename(target)}.recovery-${randomUUID()}.tmp`);
  try {
    if (before !== null) {
      await execFile("/bin/cp", ["-c", "-p", "-n", target, temporary], { timeout: 10_000 });
      const handle = await open(temporary, constants.O_RDWR | constants.O_NOFOLLOW);
      try {
        await handle.truncate(0);
        await handle.write(source, 0, source.length, 0);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } else {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.write(source);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    const current = await targetBytes(target);
    if ((current === null ? null : digest(current)) !== beforeSha256) {
      throw new BridgeClientError("FILE_CONFLICT", "Recovery target changed before commit", {}, 409);
    }
    await rename(temporary, target);
    await fsyncDirectory(parent);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  const after = await inspectBackup(options.backupDirectory, target);
  const expectedAfter = options.action === "restore-original"
    ? verified.evidence.originalSha256
    : verified.evidence.candidateSha256;
  if (after.target_sha256 !== expectedAfter) {
    throw new BridgeClientError("RECOVERY_REQUIRED", "Recovery readback hash diverged", {}, 500);
  }
  return { ...after, effect: "verified", preserved_target_sha256: beforeSha256 };
}

export async function inspectLedger(runtimeDirectoryValue: string) {
  const runtimeDirectory = exactAbsolute(runtimeDirectoryValue, "runtime directory");
  const ledger = new IdempotencyLedger(runtimeDirectory);
  return {
    schema_version: 1 as const,
    summary: await ledger.summary(),
    pending: await ledger.pendingEntries(),
  };
}

export async function reconcileLedger(options: {
  apply: boolean;
  key: string;
  payloadSha256: string;
  readbackSha256: string;
  runtimeDirectory: string;
}) {
  const runtimeDirectory = exactAbsolute(options.runtimeDirectory, "runtime directory");
  if (!options.apply) {
    return { ...(await inspectLedger(runtimeDirectory)), effect: "planned" as const };
  }
  const ledger = new IdempotencyLedger(runtimeDirectory);
  await ledger.reconcilePending(options.key, options.payloadSha256, options.readbackSha256);
  return { ...(await inspectLedger(runtimeDirectory)), effect: "verified" as const };
}
