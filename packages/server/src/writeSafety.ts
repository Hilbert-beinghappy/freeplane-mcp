import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ApplyInput, ApplyOperation, ResponseEnvelope } from "@freeplane-mcp/protocol";

import { BridgeClientError } from "./bridgeClient.js";

const MAX_ENTRIES = 10_000;
const MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export function applyPayloadHash(input: ApplyInput): string {
  return writePayloadHash(input);
}

export function writePayloadHash(input: { confirmation?: unknown; idempotency_key?: unknown; [key: string]: unknown }): string {
  const { confirmation: _confirmation, idempotency_key: _key, ...payload } = input;
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function operationHash(operations: ApplyOperation[]): string {
  return createHash("sha256").update(JSON.stringify(operations)).digest("hex");
}

export function compileOperations(operations: ApplyOperation[]): Array<Record<string, unknown>> {
  const compiled: Array<Record<string, unknown>> = [];
  for (const operation of operations) {
    switch (operation.op) {
      case "create_node":
        compiled.push({
          type: "create_child",
          temp_id: operation.temp_id,
          parent: operation.parent_id,
          position: operation.index,
          text: operation.content.text ?? "",
        });
        if (operation.content.details !== undefined) {
          compiled.push({ type: "set_details", node: operation.temp_id, value: operation.content.details });
        }
        if (operation.content.note !== undefined) {
          compiled.push({ type: "set_note", node: operation.temp_id, value: operation.content.note });
        }
        break;
      case "update_content":
        if (operation.text !== undefined) compiled.push({ type: "set_text", node: operation.node_id, value: operation.text });
        if (operation.details !== undefined) compiled.push({ type: "set_details", node: operation.node_id, value: operation.details });
        if (operation.note !== undefined) compiled.push({ type: "set_note", node: operation.node_id, value: operation.note });
        break;
      case "set_attributes":
        compiled.push({ type: "set_attributes", node: operation.node_id, attributes: operation.attributes });
        break;
      case "set_tags":
        compiled.push({ type: "set_tags", node: operation.node_id, tags: operation.tags });
        break;
      case "set_icons":
        compiled.push({ type: "set_icons", node: operation.node_id, icons: operation.icons });
        break;
      case "set_link":
        compiled.push({
          type: "set_link",
          node: operation.node_id,
          kind: operation.link.kind,
          ...(operation.link.kind === "uri" ? { uri: operation.link.uri } : {}),
          ...(operation.link.kind === "node" ? { target: operation.link.target_node_id } : {}),
          ...(operation.link.kind === "text" ? { value: operation.link.value } : {}),
        });
        break;
      case "move_node":
        compiled.push({ type: "move_node", node: operation.node_id, parent: operation.parent_id, position: operation.index });
        break;
      case "reorder_children":
        compiled.push({ type: "reorder_children", parent: operation.parent_id, children: operation.child_ids });
        break;
      case "delete_nodes":
        compiled.push(...operation.node_ids.map((node) => ({ type: "delete_node", node })));
        break;
      case "set_folded":
        compiled.push({ type: "set_folded", node: operation.node_id, value: operation.folded });
        break;
      case "add_connector":
        compiled.push({
          type: "add_connector",
          source: operation.source_id,
          target: operation.target_id,
          properties: operation.properties,
        });
        break;
      case "update_connector":
        compiled.push({ type: "update_connector", connector_id: operation.connector_id, properties: operation.properties });
        break;
      case "remove_connector":
        compiled.push(...operation.connector_ids.map((connector_id) => ({ type: "remove_connector", connector_id })));
        break;
      case "clone_node":
        compiled.push({
          type: "clone_node",
          temp_id: operation.temp_id,
          source: operation.source_id,
          parent: operation.parent_id,
          position: operation.index,
          with_subtree: false,
        });
        break;
      case "create_summary":
        compiled.push({
          type: "create_summary",
          temp_id: operation.temp_id,
          parent: operation.parent_id,
          first_child: operation.first_child_id,
          last_child: operation.last_child_id,
          text: operation.text,
        });
        break;
      case "set_free":
        compiled.push({ type: "set_free", node: operation.node_id, value: operation.free });
        break;
      case "set_side":
        compiled.push({ type: "set_side", node: operation.node_id, side: operation.side });
        break;
      case "set_style":
        compiled.push({ type: "set_style", node: operation.node_id, style: operation.style });
        break;
      case "set_layout":
        compiled.push({ type: "set_layout", node: operation.node_id, layout: operation.layout });
        break;
      case "set_cloud":
        compiled.push({
          type: "set_cloud",
          node: operation.node_id,
          enabled: operation.enabled,
          ...(operation.shape === undefined ? {} : { shape: operation.shape }),
          ...(operation.color === undefined ? {} : { color: operation.color }),
        });
        break;
      case "set_bookmark":
        compiled.push(operation.bookmark.action === "remove"
          ? { type: "set_bookmark", node: operation.node_id, action: "remove" }
          : {
              type: "set_bookmark",
              node: operation.node_id,
              action: "set",
              name: operation.bookmark.name,
              bookmark_type: operation.bookmark.type,
            });
        break;
      case "set_formula":
        compiled.push({ type: "set_formula", node: operation.node_id, expression: operation.expression });
        break;
      case "set_reminder":
        compiled.push({ type: "set_reminder", node: operation.node_id, ...operation.reminder });
        break;
    }
  }
  if (compiled.length > 500) {
    throw new BridgeClientError("LIMIT_EXCEEDED", "Expanded transaction exceeds 500 atomic operations", {}, 413);
  }
  return compiled;
}

export function operationRisk(operations: ApplyOperation[]) {
  const effects: Array<{ kind: "delete_nodes" | "remove_connector"; count: number }> = [];
  let affected = 0;
  for (const operation of operations) {
    if (operation.op === "delete_nodes") effects.push({ kind: operation.op, count: operation.node_ids.length });
    if (operation.op === "remove_connector") effects.push({ kind: operation.op, count: operation.connector_ids.length });
    affected += operation.op === "delete_nodes"
      ? operation.node_ids.length
      : operation.op === "remove_connector"
        ? operation.connector_ids.length
        : 1;
  }
  return { risk: effects.length === 0 ? "normal" as const : "confirm" as const, effects, estimatedAffectedNodes: affected };
}

interface ConfirmationBinding {
  bridgeInstanceId: string;
  mapId: string;
  contentRevision: number;
  viewRevision: number | null;
  operationHash: string;
}

interface StoredConfirmation extends ConfirmationBinding {
  planId: string;
  planHash: string;
  expiresAt: number;
}

export class ConfirmationStore {
  private readonly values = new Map<string, StoredConfirmation>();

  issue(
    binding: ConfirmationBinding,
    plan: { planId: string; planHash: string; expiresAt: string },
    effects: Array<{ kind: string; count: number }>,
    prompt?: string,
  ) {
    const confirmationId = `fpconfirm:${randomUUID()}`;
    const expiresAt = Math.min(Date.parse(plan.expiresAt), Date.now() + 5 * 60 * 1_000);
    this.values.set(confirmationId, { ...binding, ...plan, expiresAt });
    return {
      confirmation_id: confirmationId,
      expires_at: new Date(expiresAt).toISOString(),
      plan_hash: plan.planHash,
      map_id: binding.mapId,
      bound_revision: binding.contentRevision,
      effects,
      prompt: prompt ?? `This operation will delete ${effects.reduce((sum, effect) => sum + effect.count, 0)} item(s) and can be restored with one undo.`,
    };
  }

  consume(confirmationId: string, binding: ConfirmationBinding): StoredConfirmation {
    const value = this.values.get(confirmationId);
    this.values.delete(confirmationId);
    if (!value || Date.now() >= value.expiresAt) {
      throw new BridgeClientError("CONFIRMATION_EXPIRED", "Confirmation is unavailable or expired", {}, 410);
    }
    if (
      value.bridgeInstanceId !== binding.bridgeInstanceId
      || value.mapId !== binding.mapId
      || value.contentRevision !== binding.contentRevision
      || value.viewRevision !== binding.viewRevision
      || value.operationHash !== binding.operationHash
    ) {
      throw new BridgeClientError("CONFIRMATION_STALE", "Confirmation no longer matches the plan", {}, 409);
    }
    return value;
  }
}

interface LedgerEntry {
  key: string;
  payload_hash: string;
  bridge_instance_id: string;
  status: "pending" | "complete";
  created_at: string;
  result?: ResponseEnvelope;
}

interface LedgerFile {
  schema_version: 1;
  entries: LedgerEntry[];
}

export class IdempotencyLedger {
  private readonly target: string;
  private loaded = false;
  private entries = new Map<string, LedgerEntry>();
  private serial = Promise.resolve();

  constructor(runtimeDirectory: string) {
    this.target = path.join(runtimeDirectory, "write-state.json");
  }

  claim(key: string, payloadHash: string, bridgeInstanceId: string): Promise<ResponseEnvelope | null> {
    return this.lock(async () => {
      await this.load();
      const existing = this.entries.get(key);
      if (existing) {
        if (existing.payload_hash !== payloadHash) {
          throw new BridgeClientError("IDEMPOTENCY_KEY_REUSED", "Idempotency key was reused with another payload", {}, 409);
        }
        if (existing.bridge_instance_id !== bridgeInstanceId || existing.status === "pending" || !existing.result) {
          throw new BridgeClientError(
            "IDEMPOTENCY_RECONCILIATION_REQUIRED",
            "The prior write outcome requires a full read before retry",
            {},
            409,
          );
        }
        return existing.result;
      }
      this.entries.set(key, {
        key,
        payload_hash: payloadHash,
        bridge_instance_id: bridgeInstanceId,
        status: "pending",
        created_at: new Date().toISOString(),
      });
      await this.persist();
      return null;
    });
  }

  settle(key: string, result: ResponseEnvelope): Promise<void> {
    return this.lock(async () => {
      await this.load();
      const entry = this.entries.get(key);
      if (!entry) throw new BridgeClientError("RECOVERY_REQUIRED", "Idempotency entry disappeared", {}, 500);
      entry.status = "complete";
      entry.result = result;
      await this.persist();
    });
  }

  private lock<T>(action: () => Promise<T>): Promise<T> {
    const result = this.serial.then(action, action);
    this.serial = result.then(() => undefined, () => undefined);
    return result;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    await mkdir(path.dirname(this.target), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(this.target), 0o700);
    const metadata = await lstat(this.target).catch(() => null);
    if (!metadata) {
      this.loaded = true;
      return;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 || metadata.size > 32 * 1024 * 1024) {
      throw new BridgeClientError("RECOVERY_REQUIRED", "Idempotency state has unsafe metadata", {}, 500);
    }
    let value: unknown;
    try {
      value = JSON.parse(await readFile(this.target, "utf8"));
    } catch {
      throw new BridgeClientError("RECOVERY_REQUIRED", "Idempotency state is unreadable", {}, 500);
    }
    if (!isLedgerFile(value)) {
      throw new BridgeClientError("RECOVERY_REQUIRED", "Idempotency state schema is invalid", {}, 500);
    }
    const cutoff = Date.now() - MAX_AGE_MS;
    this.entries = new Map(value.entries
      .filter((entry) => Date.parse(entry.created_at) >= cutoff)
      .slice(-MAX_ENTRIES)
      .map((entry) => [entry.key, entry]));
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const entries = [...this.entries.values()]
      .filter((entry) => Date.parse(entry.created_at) >= Date.now() - MAX_AGE_MS)
      .slice(-MAX_ENTRIES);
    this.entries = new Map(entries.map((entry) => [entry.key, entry]));
    const temporary = path.join(path.dirname(this.target), `.write-state-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify({ schema_version: 1, entries })}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, this.target);
      await chmod(this.target, 0o600);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}

function isLedgerFile(value: unknown): value is LedgerFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.schema_version !== 1 || !Array.isArray(candidate.entries) || candidate.entries.length > MAX_ENTRIES) return false;
  return candidate.entries.every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const item = entry as Record<string, unknown>;
    return typeof item.key === "string"
      && typeof item.payload_hash === "string"
      && /^[a-f0-9]{64}$/.test(item.payload_hash)
      && typeof item.bridge_instance_id === "string"
      && (item.status === "pending" || item.status === "complete")
      && typeof item.created_at === "string"
      && Number.isFinite(Date.parse(item.created_at))
      && (item.status === "pending" || (item.result !== undefined && typeof item.result === "object"));
  });
}
