import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, realpath, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { FileFallbackConfig } from "./fileFallback.js";
import { underRoot } from "./fileFallback.js";
import { BridgeClientError } from "./bridgeClient.js";

const MAX_ARTIFACT_BYTES = 200 * 1024 * 1024;
export type ExportFormat = "png" | "pdf" | "svg" | "html";

export interface PreparedDestination {
  destination: string;
  parent: string;
  targetRevision: string | null;
  staging: string;
}

export interface PreparedLocalOutput {
  destination: string;
  parent: string;
  targetRevision: string | null;
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readRegular(candidate: string): Promise<{ bytes: Buffer; revision: string }> {
  const metadata = await lstat(candidate).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_ARTIFACT_BYTES) {
    throw new BridgeClientError("PATH_DENIED", "Artifact path must be a bounded regular non-symlink file", {}, 400);
  }
  const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!handle) throw new BridgeClientError("PATH_DENIED", "Artifact could not be opened without following symlinks", {}, 400);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_ARTIFACT_BYTES
        || before.dev !== metadata.dev || before.ino !== metadata.ino) {
      throw new BridgeClientError("FILE_CONFLICT", "Artifact identity or size changed before read", {}, 409);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) {
      throw new BridgeClientError("FILE_CONFLICT", "Artifact changed while being read", {}, 409);
    }
    return { bytes, revision: digest(bytes) };
  } finally {
    await handle.close();
  }
}

async function canonicalRoots(config: FileFallbackConfig): Promise<string[]> {
  const roots = await Promise.all(config.allowedRoots.map(async (root) => realpath(path.resolve(root)).catch(() => null)));
  return roots.filter((root): root is string => root !== null);
}

export async function prepareLocalOutput(
  candidate: string,
  extension: string,
  config: FileFallbackConfig,
): Promise<PreparedLocalOutput> {
  if (!path.isAbsolute(candidate) || path.extname(candidate).toLowerCase() !== `.${extension}`) {
    throw new BridgeClientError("PATH_DENIED", "Destination must be absolute and match its qualified extension", {}, 400);
  }
  const parentEntry = await lstat(path.dirname(candidate)).catch(() => null);
  if (!parentEntry?.isDirectory() || parentEntry.isSymbolicLink()) {
    throw new BridgeClientError("PATH_DENIED", "Export destination parent must be a regular non-symlink directory", {}, 400);
  }
  const parent = await realpath(path.dirname(candidate));
  const roots = await canonicalRoots(config);
  if (roots.length === 0 || !roots.some((root) => underRoot(parent, root))) {
    throw new BridgeClientError("PATH_DENIED", "Export destination is outside configured allowed roots", {}, 403);
  }
  const destination = path.join(parent, path.basename(candidate));
  const target = await lstat(destination).catch(() => null);
  if (target && (!target.isFile() || target.isSymbolicLink())) {
    throw new BridgeClientError("PATH_DENIED", "Export target must be a regular non-symlink file", {}, 400);
  }
  const targetRevision = target ? (await readRegular(destination)).revision : null;
  return { destination, parent, targetRevision };
}

export async function prepareDestination(
  candidate: string,
  format: ExportFormat,
  config: FileFallbackConfig,
): Promise<PreparedDestination> {
  const prepared = await prepareLocalOutput(candidate, format, config);
  const staging = path.join(prepared.parent, `.${path.basename(prepared.destination)}.${randomUUID()}.tmp.${format}`);
  if (await lstat(staging).catch(() => null)) {
    throw new BridgeClientError("FILE_CONFLICT", "Export staging path unexpectedly exists", {}, 409);
  }
  return { ...prepared, staging };
}

function decodeUtf8(bytes: Buffer): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new BridgeClientError("POSTCONDITION_FAILED", "Export artifact is not valid UTF-8", {}, 422); }
}

export async function validateArtifact(candidate: string, format: ExportFormat) {
  const { bytes, revision } = await readRegular(candidate);
  if (bytes.length === 0) throw new BridgeClientError("POSTCONDITION_FAILED", "Export artifact is empty", {}, 422);
  const details: Record<string, unknown> = {};
  let mime: string;
  if (format === "png") {
    const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(magic) || bytes.toString("ascii", 12, 16) !== "IHDR") {
      throw new BridgeClientError("POSTCONDITION_FAILED", "PNG magic or IHDR is invalid", {}, 422);
    }
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (width === 0 || height === 0) throw new BridgeClientError("POSTCONDITION_FAILED", "PNG dimensions are invalid", {}, 422);
    Object.assign(details, { width, height });
    mime = "image/png";
  } else if (format === "pdf") {
    const value = bytes.toString("latin1");
    const pages = [...value.matchAll(/\/Type\s*\/Page\b/g)].length;
    if (!value.startsWith("%PDF-") || !/%%EOF\s*$/u.test(value) || pages < 1) {
      throw new BridgeClientError("POSTCONDITION_FAILED", "PDF magic, EOF, or page inventory is invalid", {}, 422);
    }
    details.pages = pages;
    mime = "application/pdf";
  } else if (format === "svg") {
    let value = decodeUtf8(bytes);
    if (/<!ENTITY|<xi:include\b/iu.test(value)) {
      throw new BridgeClientError("POSTCONDITION_FAILED", "SVG contains active XML features", {}, 422);
    }
    if (/<!DOCTYPE/iu.test(value)) {
      const allowedDoctype = /<!DOCTYPE\s+svg\s+PUBLIC\s+["']-\/\/W3C\/\/DTD SVG (?:1\.0|1\.1)\/\/EN["']\s+["']http:\/\/www\.w3\.org\/(?:TR\/2001\/REC-SVG-20010904\/DTD\/svg10\.dtd|Graphics\/SVG\/1\.1\/DTD\/svg11\.dtd)["']\s*>/iu;
      const withoutDoctype = value.replace(allowedDoctype, "");
      if (withoutDoctype === value || /<!DOCTYPE/iu.test(withoutDoctype)) {
        throw new BridgeClientError("POSTCONDITION_FAILED", "SVG contains an unqualified document type", {}, 422);
      }
      value = withoutDoctype;
    }
    const body = value.replace(/^\uFEFF?\s*<\?xml[\s\S]*?\?>/iu, "").trim();
    const xmlMisc = String.raw`(?:\s*(?:<!--[\s\S]*?-->|<\?[\s\S]*?\?>)\s*)*`;
    const opening = new RegExp(`^${xmlMisc}<svg(?:\\s|>)`, "iu").test(body);
    const closing = new RegExp(`<\\/svg\\s*>${xmlMisc}$`, "iu").test(body);
    if (!opening || !closing) {
      throw new BridgeClientError("POSTCONDITION_FAILED", "SVG root is not parseable", {}, 422);
    }
    details.root = "svg";
    mime = "image/svg+xml";
  } else {
    const value = decodeUtf8(bytes);
    if (/<!ENTITY|<xi:include\b/iu.test(value) || /<script\b/iu.test(value)) {
      throw new BridgeClientError("POSTCONDITION_FAILED", "HTML contains an unqualified active payload", {}, 422);
    }
    const body = value.replace(/^\uFEFF?\s*<\?xml[\s\S]*?\?>/iu, "").trim();
    if (!/(?:<!DOCTYPE\s+html[^>]*>\s*)?<html(?:\s|>)/iu.test(body) || !/<\/html>\s*$/iu.test(body)) {
      throw new BridgeClientError("POSTCONDITION_FAILED", "HTML root is not parseable", {}, 422);
    }
    details.root = "html";
    mime = "text/html";
  }
  return { sha256: revision, size: bytes.length, mime, ...details };
}

async function currentRevision(target: string): Promise<string | null> {
  const entry = await lstat(target).catch(() => null);
  if (!entry) return null;
  return (await readRegular(target)).revision;
}

async function syncFile(target: string) {
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function commitArtifact(
  prepared: PreparedDestination,
  format: ExportFormat,
  overwriteAuthorized: boolean,
  backupRoot: string,
) {
  const staged = await validateArtifact(prepared.staging, format);
  const current = await currentRevision(prepared.destination);
  if (current !== prepared.targetRevision) {
    throw new BridgeClientError("FILE_CONFLICT", "Export target changed after planning", {}, 409);
  }
  if (current !== null && !overwriteAuthorized) {
    throw new BridgeClientError("CONFIRMATION_REQUIRED", "Existing export target requires confirmation", {}, 409);
  }

  let backupId: string | null = null;
  if (current !== null) {
    backupId = randomUUID();
    const directory = path.join(backupRoot, backupId);
    await mkdir(directory, { recursive: false, mode: 0o700 });
    await chmod(directory, 0o700);
    const original = path.join(directory, `original.${format}`);
    const manifest = path.join(directory, "manifest.json");
    await copyFile(prepared.destination, original, constants.COPYFILE_EXCL);
    await chmod(original, 0o600);
    if ((await readRegular(original)).revision !== current) {
      throw new BridgeClientError("FILE_CONFLICT", "Export target changed while its backup was created", {}, 409);
    }
    await writeFile(manifest, `${JSON.stringify({
      schema_version: 1,
      backup_id: backupId,
      format,
      target_sha256_before: current,
      replacement_sha256: staged.sha256,
    }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await Promise.all([syncFile(original), syncFile(manifest)]);
    const backupParent = await open(directory, constants.O_RDONLY);
    try { await backupParent.sync(); } finally { await backupParent.close(); }
    const backupRootHandle = await open(backupRoot, constants.O_RDONLY);
    try { await backupRootHandle.sync(); } finally { await backupRootHandle.close(); }
  }

  await syncFile(prepared.staging);
  if (await currentRevision(prepared.destination) !== current) {
    throw new BridgeClientError("FILE_CONFLICT", "Export target changed before atomic replacement", {}, 409);
  }
  await rename(prepared.staging, prepared.destination);
  const parent = await open(prepared.parent, constants.O_RDONLY);
  try { await parent.sync(); } finally { await parent.close(); }
  const artifact = await validateArtifact(prepared.destination, format);
  if (artifact.sha256 !== staged.sha256) {
    throw new BridgeClientError("RECOVERY_REQUIRED", "Committed export hash diverged; backup evidence was retained", {}, 500);
  }
  return { ...artifact, backupId };
}

export async function removeStaging(prepared: PreparedDestination | null) {
  if (prepared) await unlink(prepared.staging).catch(() => undefined);
}
