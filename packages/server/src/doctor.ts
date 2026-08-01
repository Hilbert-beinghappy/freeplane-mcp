import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { axHelperConfig, probeAxHelper } from "./axHelper.js";
import { connectBridge } from "./bridgeClient.js";
import { inspectInstallation, RELEASE_VERSION } from "./install.js";
import { loadProbeResult, runtimeOptions } from "./mcp.js";
import { runProbe } from "./probe.js";
import { inspectLedger } from "./recovery.js";

const execFile = promisify(execFileCallback);

interface DoctorCheck {
  id: string;
  status: "pass" | "fail" | "info";
  evidence: string;
}

async function listenerSummary(pid: number): Promise<{ observed: boolean; count: number; public_count: number }> {
  try {
    const { stdout } = await execFile("/usr/sbin/lsof", [
      "-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn",
    ], { timeout: 5_000, maxBuffer: 256 * 1024 });
    const listeners = stdout.split("\n").filter((line) => line.startsWith("n")).map((line) => line.slice(1));
    return {
      observed: true,
      count: listeners.length,
      public_count: listeners.filter((address) =>
        !address.startsWith("127.0.0.1:") && !address.startsWith("[::1]:") && !address.startsWith("localhost:"),
      ).length,
    };
  } catch {
    return { observed: false, count: 0, public_count: 0 };
  }
}

export async function runDoctor(options: {
  freeplaneApp?: string;
  prefix: string;
  root: string;
}) {
  const install = await inspectInstallation(options.prefix);
  const manifest = install.manifest;
  const root = path.resolve(options.root);
  const profile = manifest?.freeplane_user_directory;
  const runtime = manifest?.runtime_directory
    ?? process.env.FREEPLANE_MCP_RUNTIME_DIR
    ?? path.join(path.dirname(options.prefix), "runtime");
  const result = await loadProbeResult(root);
  const freeplaneApp = options.freeplaneApp ?? manifest?.freeplane_app;
  const fresh = await runProbe({
    root,
    ...(freeplaneApp ? { freeplaneApp } : {}),
    ...(profile ? { freeplaneUserDirectory: profile } : {}),
  });
  const staticFailures = fresh.report.checks.filter(
    (check) => check.status === "fail" && check.id !== "protocol.codex_stdio_handshake",
  );
  const configured = runtimeOptions(result.manifest, {
    ...process.env,
    FREEPLANE_MCP_RUNTIME_DIR: runtime,
    ...(manifest ? { FREEPLANE_MCP_AX_HELPER: path.join(manifest.prefix, "libexec/freeplane-mcp-ax-helper") } : {}),
  });
  const [accessibility, ledger, bridge] = await Promise.all([
    probeAxHelper(axHelperConfig({
      ...process.env,
      ...(manifest ? { FREEPLANE_MCP_AX_HELPER: path.join(manifest.prefix, "libexec/freeplane-mcp-ax-helper") } : {}),
    })),
    inspectLedger(runtime),
    connectBridge(configured.bridge).catch(() => null),
  ]);
  const listeners = bridge
    ? await listenerSummary(bridge.health.pid)
    : { observed: false, count: 0, public_count: 0 };
  const capabilityBytes = await readFile(path.join(root, "qualification/capabilities/capabilities.json"));
  const supported = result.manifest.capabilities.filter((capability) => capability.status !== "unsupported").length;
  const checks: DoctorCheck[] = [
    {
      id: "runtime.node22",
      status: Number(process.versions.node.split(".")[0]) === 22 ? "pass" : "fail",
      evidence: `Node ${process.versions.node}`,
    },
    {
      id: "installation.manifest",
      status: install.state === "verified" ? "pass" : install.state === "absent" ? "info" : "fail",
      evidence: install.state === "verified"
        ? `${install.checked_files} manifest-owned files verified`
        : install.state === "absent" ? "source-tree diagnostic" : `${install.problems.length} install problems`,
    },
    {
      id: "compatibility.exact_build",
      status: staticFailures.length === 0 ? "pass" : "fail",
      evidence: staticFailures.length === 0 ? "Freeplane 1.13.3 fingerprint and dependencies match" : staticFailures.map((item) => item.id).join(","),
    },
    {
      id: "bridge.loopback_only",
      status: bridge && !listeners.observed ? "fail" : listeners.public_count === 0 ? "pass" : "fail",
      evidence: bridge
        ? listeners.observed ? `${listeners.count} TCP listeners, ${listeners.public_count} public` : "listener inspection failed"
        : "bridge is not running; no bridge listener exists",
    },
    {
      id: "recovery.classified",
      status: ledger.summary.pending === 0 ? "pass" : "info",
      evidence: `${ledger.summary.pending} pending idempotency outcomes`,
    },
    {
      id: "privacy.redacted",
      status: "pass",
      evidence: "paths are home-redacted; tokens, payloads, and map content are omitted",
    },
  ];
  return {
    schema_version: 1,
    doctor_version: RELEASE_VERSION,
    passed: checks.every((check) => check.status !== "fail"),
    generated_at: new Date().toISOString(),
    system: { platform: process.platform, arch: process.arch, node_version: process.versions.node },
    installation: {
      state: install.state,
      prefix: "$INSTALL_ROOT",
      checked_files: install.checked_files,
      problem_count: install.problems.length,
    },
    compatibility: {
      freeplane_app: "$FREEPLANE_APP",
      freeplane_version: fresh.report.freeplane.version,
      bundled_java_version: fresh.report.freeplane.bundled_java_version,
      build_fingerprint: fresh.report.freeplane.build_fingerprint,
      static_failure_ids: staticFailures.map((check) => check.id),
      builtin_mcp: {
        detected: fresh.report.builtin_mcp.detected,
        enabled_setting: fresh.report.builtin_mcp.enabled_setting,
        port_listening: fresh.report.builtin_mcp.port_listening,
      },
    },
    capabilities: {
      qualification_report: result.manifest.capabilities[0]?.qualification_report ?? null,
      manifest_sha256: createHash("sha256").update(capabilityBytes).digest("hex"),
      total: result.manifest.capabilities.length,
      supported,
      unsupported: result.manifest.capabilities.length - supported,
    },
    bridge: {
      connected: bridge !== null,
      instance_id: bridge?.client.instanceId ?? null,
      addon_version: bridge?.health.addon_version ?? null,
      host: bridge?.health.host ?? null,
      listener_inspection_observed: listeners.observed,
      public_listener_count: listeners.public_count,
    },
    accessibility: {
      helper_available: accessibility.available,
      helper_version: accessibility.helper_version,
      permission: accessibility.permission,
    },
    recovery: {
      required: ledger.summary.pending > 0 || bridge?.health.registry.recovery_required === true,
      pending_idempotency_count: ledger.summary.pending,
      reconciled_idempotency_count: ledger.summary.reconciled,
      map_recovery_required: bridge?.health.registry.recovery_required === true,
    },
    privacy: { redacted: true, token_included: false, map_content_included: false, telemetry: false },
    checks,
  };
}
