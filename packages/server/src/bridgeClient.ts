import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { ErrorCategorySchema, type ErrorCategory } from "@freeplane-mcp/protocol";
import * as z from "zod/v4";

const DiscoverySchema = z
  .object({
    schema_version: z.literal(1),
    bridge_instance_id: z.uuid(),
    pid: z.int().positive(),
    process_start_time: z.iso.datetime(),
    host: z.literal("127.0.0.1"),
    port: z.int().min(1).max(65_535),
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    freeplane_version: z.string().min(1),
    freeplane_build_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    addon_version: z.string().min(1),
    created_at: z.iso.datetime(),
    expires_at: z.iso.datetime(),
  })
  .strict();

const BridgeEnvelopeSchema = z
  .object({
    schema_version: z.literal(1),
    ok: z.boolean(),
    request_id: z.string().nullable(),
    bridge_instance_id: z.string().min(1),
    data: z.unknown().nullable(),
    error: z
      .object({
        category: z.string().min(1),
        message: z.string().min(1),
        details: z.record(z.string(), z.unknown()),
      })
      .strict()
      .nullable(),
  })
  .strict();

const HealthSchema = z
  .object({
    bridge_instance_id: z.string().min(1),
    status: z.literal("ok"),
    host: z.literal("127.0.0.1"),
    port: z.int().min(1).max(65_535),
    pid: z.int().positive(),
    freeplane_version: z.string().min(1),
    addon_version: z.string().min(1),
    qualification_mode: z.boolean(),
    registry: z.record(z.string(), z.unknown()),
  })
  .strict();

type Discovery = z.infer<typeof DiscoverySchema>;
export type BridgeHealth = z.infer<typeof HealthSchema>;

export interface BridgeConfig {
  runtimeDirectory: string;
  expectedFingerprint: string;
  expectedFreeplaneVersion: string;
  expectedAddonVersion: string | null;
  timeoutMs: number;
}

export class BridgeClientError extends Error {
  constructor(
    readonly category: ErrorCategory,
    message: string,
    readonly details: Record<string, unknown> = {},
    readonly status = 503,
  ) {
    super(message);
  }
}

export class BridgeClient {
  readonly instanceId: string;
  readonly discovery: Omit<Discovery, "token">;

  constructor(
    discovery: Discovery,
    private readonly token: string,
    private readonly timeoutMs: number,
  ) {
    this.instanceId = discovery.bridge_instance_id;
    const { token: _token, ...safeDiscovery } = discovery;
    this.discovery = safeDiscovery;
  }

  async request(method: "GET" | "POST", endpoint: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${this.discovery.port}${endpoint}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "X-Request-Id": `mcp-${randomUUID()}`,
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new BridgeClientError(
        error instanceof DOMException && error.name === "TimeoutError" ? "TIMEOUT" : "BRIDGE_UNAVAILABLE",
        "Freeplane bridge request failed",
      );
    }

    const responseText = await readBoundedResponseText(response);
    let parsed: unknown;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      throw new BridgeClientError("BRIDGE_UNAVAILABLE", "Freeplane bridge returned malformed JSON");
    }
    const envelope = BridgeEnvelopeSchema.safeParse(parsed);
    if (!envelope.success || envelope.data.bridge_instance_id !== this.instanceId) {
      throw new BridgeClientError("BRIDGE_UNAVAILABLE", "Freeplane bridge identity or response schema changed");
    }
    if (!response.ok || !envelope.data.ok) {
      const error = envelope.data.error;
      const category = ErrorCategorySchema.safeParse(error?.category);
      throw new BridgeClientError(
        category.success ? category.data : "FREEPLANE_ERROR",
        error?.message ?? `Freeplane bridge returned HTTP ${response.status}`,
        error?.details ?? {},
        response.status,
      );
    }
    if (envelope.data.error !== null) {
      throw new BridgeClientError("BRIDGE_UNAVAILABLE", "Successful bridge response contained an error");
    }
    return envelope.data.data;
  }
}

export async function readBoundedResponseText(response: Response, maximum = 64 * 1024 * 1024): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new BridgeClientError("LIMIT_EXCEEDED", "Freeplane bridge response exceeds 64 MiB");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

export function bridgeConfig(
  expectedFingerprint: string,
  expectedFreeplaneVersion: string,
  expectedAddonVersion: string | null,
  env: NodeJS.ProcessEnv = process.env,
): BridgeConfig {
  return {
    runtimeDirectory:
      env.FREEPLANE_MCP_RUNTIME_DIR
      ?? path.join(homedir(), "Library", "Application Support", "Freeplane-MCP", "runtime"),
    expectedFingerprint,
    expectedFreeplaneVersion,
    expectedAddonVersion,
    timeoutMs: 1_500,
  };
}

async function pidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function connectBridge(config: BridgeConfig): Promise<{
  client: BridgeClient;
  health: BridgeHealth;
  latencyMs: number;
}> {
  const discoveryPath = path.join(config.runtimeDirectory, "bridge.json");
  const [runtimeEntry, discoveryEntry] = await Promise.all([
    lstat(config.runtimeDirectory).catch(() => null),
    lstat(discoveryPath).catch(() => null),
  ]);
  if (
    !runtimeEntry?.isDirectory()
    || runtimeEntry.isSymbolicLink()
    || !discoveryEntry?.isFile()
    || discoveryEntry.isSymbolicLink()
    || (runtimeEntry.mode & 0o077) !== 0
    || (discoveryEntry.mode & 0o077) !== 0
    || discoveryEntry.size > 64 * 1024
  ) {
    throw new BridgeClientError("BRIDGE_UNAVAILABLE", "Bridge discovery is missing or has unsafe metadata");
  }
  if (typeof process.getuid === "function" && (runtimeEntry.uid !== process.getuid() || discoveryEntry.uid !== process.getuid())) {
    throw new BridgeClientError("BRIDGE_UNAVAILABLE", "Bridge discovery is owned by another user");
  }

  let value: unknown;
  try {
    value = JSON.parse(await readFile(discoveryPath, "utf8"));
  } catch {
    throw new BridgeClientError("BRIDGE_UNAVAILABLE", "Bridge discovery is malformed");
  }
  const parsed = DiscoverySchema.safeParse(value);
  if (!parsed.success) throw new BridgeClientError("BRIDGE_UNAVAILABLE", "Bridge discovery schema is invalid");
  const discovery = parsed.data;
  if (
    Buffer.from(discovery.token, "base64url").length !== 32
    || discovery.freeplane_build_fingerprint !== config.expectedFingerprint
    || discovery.freeplane_version !== config.expectedFreeplaneVersion
    || (config.expectedAddonVersion !== null && discovery.addon_version !== config.expectedAddonVersion)
    || Date.parse(discovery.created_at) > Date.now() + 60_000
    || Date.parse(discovery.expires_at) <= Date.now()
    || !(await pidAlive(discovery.pid))
  ) {
    throw new BridgeClientError("BRIDGE_UNAVAILABLE", "Bridge discovery is stale or incompatible");
  }

  const client = new BridgeClient(discovery, discovery.token, config.timeoutMs);
  const started = performance.now();
  const health = HealthSchema.safeParse(await client.request("GET", "/v1/health"));
  const latencyMs = performance.now() - started;
  if (
    !health.success
    || health.data.bridge_instance_id !== discovery.bridge_instance_id
    || health.data.pid !== discovery.pid
    || health.data.port !== discovery.port
    || health.data.freeplane_version !== discovery.freeplane_version
    || health.data.addon_version !== discovery.addon_version
  ) {
    throw new BridgeClientError("BRIDGE_UNAVAILABLE", "Bridge health identity does not match discovery");
  }
  return { client, health: health.data, latencyMs };
}
