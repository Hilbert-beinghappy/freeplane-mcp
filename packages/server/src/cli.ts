import path from "node:path";

import { runCodexHostProbe } from "./codexProbe.js";
import { runDoctor } from "./doctor.js";
import {
  defaultInstallPaths,
  installLocal,
  uninstallLocal,
} from "./install.js";
import { runProbe, writeProbeResult } from "./probe.js";
import {
  applyBackupRecovery,
  inspectBackup,
  inspectLedger,
  reconcileLedger,
} from "./recovery.js";

function parseOptions(args: string[], valueNames: string[], flagNames: string[]) {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const name = args[index]!;
    if (flagNames.includes(name)) {
      if (flags.has(name)) throw new Error(`Duplicate option: ${name}`);
      flags.add(name);
      continue;
    }
    if (!valueNames.includes(name)) throw new Error(`Unknown option: ${name}`);
    if (values.has(name)) throw new Error(`Duplicate option: ${name}`);
    const value = args[++index];
    if (!value) throw new Error(`${name} requires a value`);
    values.set(name, value);
  }
  return {
    flag: (name: string) => flags.has(name),
    optional: (name: string) => values.get(name),
    required: (name: string) => {
      const value = values.get(name);
      if (!value) throw new Error(`${name} is required`);
      return value;
    },
  };
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function probeCommand(args: string[]): Promise<void> {
  const options = parseOptions(args, ["--app"], []);
  const freeplaneApp = options.optional("--app");
  const result = await runProbe(freeplaneApp ? { freeplaneApp } : {});
  await writeProbeResult(result);
  const handshakeIndex = result.report.checks.findIndex(
    (check) => check.id === "protocol.codex_stdio_handshake",
  );
  try {
    const handshake = await runCodexHostProbe();
    result.report.codex.host_handshake = handshake;
    result.report.checks[handshakeIndex] = {
      id: "protocol.codex_stdio_handshake",
      status: "pass",
      evidence: `${handshake.server_name} exposed ${handshake.tool_names.length} tools through local Codex`,
    };
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Codex host handshake failed"}\n`);
    result.report.checks[handshakeIndex] = {
      id: "protocol.codex_stdio_handshake",
      status: "fail",
      evidence: "Local Codex did not complete the isolated STDIO qualification handshake",
    };
  }
  result.report.passed = result.report.checks.every((check) => check.status === "pass");
  await writeProbeResult(result);
  writeJson({
    passed: result.report.passed,
    report: "qualification/reports/v0.0a-local.json",
    capabilities: "qualification/capabilities/capabilities.json",
    fingerprint: result.report.freeplane.build_fingerprint,
  });
  if (!result.report.passed) process.exitCode = 1;
}

async function installCommand(args: string[]): Promise<void> {
  const options = parseOptions(args, [
    "--prefix",
    "--freeplane-user-dir",
    "--runtime-dir",
    "--app",
    "--source-root",
    "--capabilities",
  ], ["--apply", "--allow-existing-profile"]);
  const defaults = defaultInstallPaths();
  const freeplaneApp = options.optional("--app");
  const capabilityManifestPath = options.optional("--capabilities");
  writeJson(await installLocal({
    apply: options.flag("--apply"),
    allowExistingProfile: options.flag("--allow-existing-profile"),
    prefix: options.optional("--prefix") ?? defaults.prefix,
    freeplaneUserDirectory: options.optional("--freeplane-user-dir") ?? defaults.freeplaneUserDirectory,
    runtimeDirectory: options.optional("--runtime-dir") ?? defaults.runtimeDirectory,
    sourceRoot: options.optional("--source-root") ?? process.cwd(),
    ...(freeplaneApp ? { freeplaneApp } : {}),
    ...(capabilityManifestPath
      ? { capabilityManifestPath: path.resolve(capabilityManifestPath) }
      : {}),
  }));
}

async function uninstallCommand(args: string[]): Promise<void> {
  const options = parseOptions(args, ["--prefix"], ["--apply"]);
  const prefix = options.optional("--prefix")
    ?? process.env.FREEPLANE_MCP_INSTALL_ROOT
    ?? defaultInstallPaths().prefix;
  writeJson(await uninstallLocal(prefix, options.flag("--apply")));
}

async function doctorCommand(args: string[]): Promise<void> {
  const options = parseOptions(args, ["--root", "--prefix", "--app"], []);
  const root = options.optional("--root") ?? process.env.FREEPLANE_MCP_INSTALL_ROOT ?? process.cwd();
  const prefix = options.optional("--prefix") ?? process.env.FREEPLANE_MCP_INSTALL_ROOT ?? defaultInstallPaths().prefix;
  const freeplaneApp = options.optional("--app");
  writeJson(await runDoctor({
    root,
    prefix,
    ...(freeplaneApp ? { freeplaneApp } : {}),
  }));
}

async function recoverCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  if (action === "inspect") {
    const options = parseOptions(rest, ["--backup", "--target"], []);
    writeJson(await inspectBackup(options.required("--backup"), options.required("--target")));
    return;
  }
  if (action === "restore-original" || action === "apply-candidate") {
    const options = parseOptions(rest, ["--backup", "--target", "--expected-target-sha256"], ["--apply"]);
    writeJson(await applyBackupRecovery({
      action,
      backupDirectory: options.required("--backup"),
      target: options.required("--target"),
      expectedTargetSha256: options.required("--expected-target-sha256"),
      apply: options.flag("--apply"),
    }));
    return;
  }
  if (action === "ledger") {
    const options = parseOptions(rest, ["--runtime-dir"], []);
    writeJson(await inspectLedger(options.required("--runtime-dir")));
    return;
  }
  if (action === "reconcile-ledger") {
    const options = parseOptions(rest, [
      "--runtime-dir", "--key", "--payload-sha256", "--readback-sha256",
    ], ["--apply"]);
    writeJson(await reconcileLedger({
      runtimeDirectory: options.required("--runtime-dir"),
      key: options.required("--key"),
      payloadSha256: options.required("--payload-sha256"),
      readbackSha256: options.required("--readback-sha256"),
      apply: options.flag("--apply"),
    }));
    return;
  }
  throw new Error("Usage: freeplane-mcp recover inspect|restore-original|apply-candidate|ledger|reconcile-ledger ...");
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === "probe") await probeCommand(args);
  else if (command === "install") await installCommand(args);
  else if (command === "uninstall") await uninstallCommand(args);
  else if (command === "doctor") await doctorCommand(args);
  else if (command === "recover") await recoverCommand(args);
  else throw new Error("Usage: freeplane-mcp probe|install|uninstall|doctor|recover ...");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Freeplane MCP command failed"}\n`);
  process.exitCode = 1;
}
