import { execFile as execFileCallback } from "node:child_process";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { ErrorCategorySchema } from "@freeplane-mcp/protocol";
import * as z from "zod/v4";

import { BridgeClientError } from "./bridgeClient.js";

const execFile = promisify(execFileCallback);

const AxHelperResponseSchema = z
  .object({
    schema_version: z.literal(1),
    ok: z.boolean(),
    helper_version: z.literal("1.0.0"),
    trusted: z.boolean().optional(),
    bundle_id: z.literal("org.freeplane.launcher").optional(),
    pid: z.int().positive().optional(),
    capability_id: z.enum(["presentation.navigate", "print.preview"]).optional(),
    action: z.enum(["start", "stop", "first", "previous", "next", "last", "open", "close"]).optional(),
    effect: z.enum(["planned", "pressed", "closed"]).optional(),
    locale: z.enum(["en", "zh_CN"]).optional(),
    menu_resolution: z.enum(["resolved", "deferred_until_focus"]).optional(),
    resolved_titles: z.array(z.string().min(1).max(128)).max(4).optional(),
    preview_open: z.boolean().optional(),
    frontmost_before_matches: z.boolean().optional(),
    frontmost_after_matches: z.boolean().optional(),
    focus_recovered: z.boolean().optional(),
    error: z
      .object({
        code: z.string().min(1).max(64),
        message: z.string().min(1).max(512),
      })
      .strict()
      .optional(),
  })
  .strict();

export interface AxHelperConfig {
  path: string;
  timeoutMs: number;
}

export interface AxInvokeRequest {
  schema_version: 1;
  command: "invoke";
  pid: number;
  expected_locale: "en" | "zh_CN";
  capability_id: "presentation.navigate" | "print.preview";
  action: "start" | "stop" | "first" | "previous" | "next" | "last" | "open" | "close";
  dry_run: boolean;
}

export type AxHelperResponse = z.infer<typeof AxHelperResponseSchema>;

export function axHelperConfig(env: NodeJS.ProcessEnv = process.env): AxHelperConfig {
  return {
    path: env.FREEPLANE_MCP_AX_HELPER
      ?? path.join(homedir(), "Library/Application Support/Freeplane-MCP/bin/freeplane-mcp-ax-helper"),
    timeoutMs: 8_000,
  };
}

async function validateExecutable(config: AxHelperConfig): Promise<void> {
  if (!path.isAbsolute(config.path)) {
    throw new BridgeClientError("CAPABILITY_UNAVAILABLE", "Accessibility helper path must be absolute");
  }
  const [entry, parent] = await Promise.all([
    lstat(config.path).catch(() => null),
    lstat(path.dirname(config.path)).catch(() => null),
  ]);
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (
    !entry?.isFile()
    || entry.isSymbolicLink()
    || (entry.mode & 0o111) === 0
    || (entry.mode & 0o022) !== 0
    || !parent?.isDirectory()
    || parent.isSymbolicLink()
    || (parent.mode & 0o022) !== 0
    || (expectedUid !== null && (entry.uid !== expectedUid || parent.uid !== expectedUid))
  ) {
    throw new BridgeClientError("CAPABILITY_UNAVAILABLE", "Accessibility helper is missing or has unsafe metadata");
  }
  try {
    await execFile("/usr/bin/codesign", ["--verify", "--strict", config.path], {
      timeout: config.timeoutMs,
      maxBuffer: 64 * 1024,
    });
  } catch {
    throw new BridgeClientError("CAPABILITY_UNAVAILABLE", "Accessibility helper signature is invalid");
  }
}

async function run(config: AxHelperConfig, request: object): Promise<AxHelperResponse> {
  await validateExecutable(config);
  let stdout: string;
  try {
    ({ stdout } = await execFile(config.path, [JSON.stringify(request)], {
      timeout: config.timeoutMs,
      maxBuffer: 64 * 1024,
    }));
  } catch {
    throw new BridgeClientError("CAPABILITY_UNAVAILABLE", "Accessibility helper did not return a bounded response");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new BridgeClientError("CAPABILITY_UNAVAILABLE", "Accessibility helper returned malformed JSON");
  }
  const response = AxHelperResponseSchema.safeParse(parsed);
  if (!response.success) {
    throw new BridgeClientError("CAPABILITY_UNAVAILABLE", "Accessibility helper response schema is invalid");
  }
  if (!response.data.ok) {
    const helperError = response.data.error;
    const category = ErrorCategorySchema.safeParse(helperError?.code);
    throw new BridgeClientError(
      category.success ? category.data : "FREEPLANE_ERROR",
      helperError?.message ?? "Accessibility helper rejected the request",
    );
  }
  if (response.data.error !== undefined) {
    throw new BridgeClientError("CAPABILITY_UNAVAILABLE", "Successful Accessibility response contained an error");
  }
  return response.data;
}

export async function probeAxHelper(config: AxHelperConfig): Promise<{
  available: boolean;
  permission: "granted" | "denied" | "unavailable";
  helper_version: string | null;
}> {
  try {
    const response = await run(config, { schema_version: 1, command: "status" });
    return {
      available: true,
      permission: response.trusted === true ? "granted" : "denied",
      helper_version: response.helper_version,
    };
  } catch {
    return { available: false, permission: "unavailable", helper_version: null };
  }
}

export async function invokeAxHelper(config: AxHelperConfig, request: AxInvokeRequest): Promise<AxHelperResponse> {
  const response = await run(config, request);
  if (
    response.pid !== request.pid
    || response.capability_id !== request.capability_id
    || response.action !== request.action
    || response.bundle_id !== "org.freeplane.launcher"
    || response.locale !== request.expected_locale
    || response.effect !== (request.dry_run ? "planned" : request.action === "close" ? "closed" : "pressed")
    || (!request.dry_run && response.frontmost_after_matches !== true)
    || (!request.dry_run && response.menu_resolution !== "resolved")
  ) {
    throw new BridgeClientError("POSTCONDITION_FAILED", "Accessibility helper identity readback diverged");
  }
  return response;
}
