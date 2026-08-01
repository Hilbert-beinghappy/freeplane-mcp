import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  CapabilityManifestSchema,
  type Capability,
  type CapabilityManifest,
} from "@freeplane-mcp/protocol";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/server";

const execFile = promisify(execFileCallback);
const SHA256 = /^[a-f0-9]{64}$/;

interface ArtifactBaseline {
  relative_path: string;
  sha256: string;
}

interface ClassProbeBaseline {
  id: string;
  class_name: string;
  classpath: string[];
  signatures: string[];
}

interface Baseline {
  schema_version: 1;
  bundle_identifier: string;
  freeplane_version: string;
  build_fingerprint: string;
  protocol_revision: string;
  mcp_sdk_version: string;
  zod_version: string;
  artifacts: ArtifactBaseline[];
  class_probes: ClassProbeBaseline[];
  menu_inventory: {
    entry_count: number;
    unique_name_count: number;
    action_entry_count: number;
    unique_action_count: number;
    required_actions: string[];
  };
}

export interface ProbeCheck {
  id: string;
  status: "pass" | "fail";
  evidence: string;
}

export interface QualificationReport {
  schema_version: 1;
  stage: "v0.0A";
  generated_at: string;
  passed: boolean;
  qualification_report: string;
  fixed_protocol_revision: string;
  system: {
    platform: NodeJS.Platform;
    arch: string;
    node_version: string;
  };
  codex: {
    detected: boolean;
    version: string | null;
    location: string | null;
    embedded_protocol_revisions: string[];
    host_handshake: {
      protocol_revision: string;
      server_name: string;
      tool_names: string[];
      tool_call_verified: boolean;
    } | null;
  };
  freeplane: {
    location: string;
    bundle_identifier: string;
    version: string;
    bundled_java_version: string;
    build_fingerprint: string;
    artifact_count: number;
  };
  builtin_mcp: {
    detected: boolean;
    enabled_setting: boolean;
    port: number;
    port_listening: boolean;
    protocol_revision: string | null;
    token_observed: false;
  };
  menu_inventory: {
    entry_count: number;
    unique_name_count: number;
    action_entry_count: number;
    unique_action_count: number;
    required_actions_present: string[];
  };
  checks: ProbeCheck[];
  capabilities: Capability[];
}

export interface ProbeResult {
  report: QualificationReport;
  manifest: CapabilityManifest;
}

export interface ProbeOptions {
  baselinePath?: string;
  freeplaneApp?: string;
  now?: Date;
}

const KNOWN_PROTOCOL_REVISIONS = [
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
  "2026-07-28",
] as const;

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function discoverFreeplaneApp(explicit?: string): Promise<string> {
  const candidates = [explicit, process.env.FREEPLANE_APP].filter(
    (value): value is string => Boolean(value),
  );

  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFile("/usr/bin/mdfind", [
        "kMDItemCFBundleIdentifier == 'org.freeplane.launcher'",
      ]);
      candidates.push(...stdout.split("\n").filter((line) => line.endsWith(".app")));
    } catch {
      // Spotlight is optional; deterministic filesystem fallbacks follow.
    }
  }

  candidates.push("/Applications/Freeplane.app", path.join(homedir(), "Applications/Freeplane.app"));
  for (const candidate of candidates) {
    if (await exists(candidate)) return realpath(candidate);
  }
  throw new Error("Freeplane.app was not found; set FREEPLANE_APP to its absolute path");
}

async function sha256File(file: string): Promise<{ sha256: string; size: number }> {
  const bytes = await readFile(file);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: (await stat(file)).size,
  };
}

function buildFingerprint(artifacts: Array<ArtifactBaseline & { size: number }>): string {
  const canonical = [...artifacts]
    .sort((left, right) =>
      left.relative_path < right.relative_path ? -1 : left.relative_path > right.relative_path ? 1 : 0,
    )
    .map((artifact) => `${artifact.relative_path}\0${artifact.sha256}\n`)
    .join("");
  return createHash("sha256").update(canonical).digest("hex");
}

function parseEntryNames(xml: string): string[] {
  return [...xml.matchAll(/<Entry\b[\s\S]*?>/g)]
    .map((match) => /\bname\s*=\s*(["'])([\s\S]*?)\1/.exec(match[0])?.[2])
    .filter((name): name is string => name !== undefined);
}

async function inspectMenus(app: string, baseline: Baseline): Promise<QualificationReport["menu_inventory"]> {
  const menuArtifacts = baseline.artifacts.filter((artifact) => artifact.relative_path.endsWith("modemenu.xml"));
  const names = (
    await Promise.all(menuArtifacts.map((artifact) => readFile(path.join(app, artifact.relative_path), "utf8")))
  ).flatMap(parseEntryNames);
  const actions = names.filter((name) => /Action(?:\.|$)/.test(name));
  const uniqueNames = new Set(names);
  const uniqueActions = new Set(actions);

  return {
    entry_count: names.length,
    unique_name_count: uniqueNames.size,
    action_entry_count: actions.length,
    unique_action_count: uniqueActions.size,
    required_actions_present: baseline.menu_inventory.required_actions.filter((action) => uniqueNames.has(action)),
  };
}

async function plistValue(infoPlist: string, key: string): Promise<string> {
  const { stdout } = await execFile("/usr/bin/plutil", ["-extract", key, "raw", infoPlist]);
  return stdout.trim();
}

async function inspectClass(
  app: string,
  javap: string,
  probe: ClassProbeBaseline,
): Promise<ProbeCheck> {
  try {
    const classpath = probe.classpath.map((entry) => path.join(app, entry)).join(path.delimiter);
    const { stdout } = await execFile(javap, ["-p", "-constants", "-classpath", classpath, probe.class_name], {
      maxBuffer: 4 * 1024 * 1024,
    });
    const missing = probe.signatures.filter((signature) => !stdout.includes(signature));
    return {
      id: `class.${probe.id}`,
      status: missing.length === 0 ? "pass" : "fail",
      evidence:
        missing.length === 0
          ? `${probe.class_name}: ${probe.signatures.length} required signatures present`
          : `${probe.class_name}: missing ${missing.join(", ")}`,
    };
  } catch (error) {
    return {
      id: `class.${probe.id}`,
      status: "fail",
      evidence: error instanceof Error ? error.message : "javap failed",
    };
  }
}

async function readJavaVersion(java: string): Promise<string> {
  try {
    const { stderr } = await execFile(java, ["-version"]);
    return /version "([^"]+)"/.exec(stderr)?.[1] ?? "unknown";
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    return /version "([^"]+)"/.exec(stderr)?.[1] ?? "unknown";
  }
}

async function findCodex(): Promise<QualificationReport["codex"]> {
  let executable: string | null = process.env.CODEX_CLI ?? null;
  if (!executable) {
    try {
      executable = (await execFile("/usr/bin/which", ["codex"])).stdout.trim();
    } catch {
      executable = null;
    }
  }
  if (!executable || !(await exists(executable))) {
    return {
      detected: false,
      version: null,
      location: null,
      embedded_protocol_revisions: [],
      host_handshake: null,
    };
  }

  const version = (await execFile(executable, ["--version"])).stdout.trim();
  const binary = await readFile(executable);
  const embedded = KNOWN_PROTOCOL_REVISIONS.filter((revision) => binary.includes(Buffer.from(revision)));
  return {
    detected: true,
    version,
    location: redactHome(executable),
    embedded_protocol_revisions: embedded,
    host_handshake: null,
  };
}

async function lockedDependencyVersions(): Promise<{
  clientSdk: string | null;
  serverSdk: string | null;
  zod: string[];
}> {
  const lockPath = path.resolve("package-lock.json");
  if (!(await exists(lockPath))) return { clientSdk: null, serverSdk: null, zod: [] };
  const lock = JSON.parse(await readFile(lockPath, "utf8")) as {
    packages?: Record<string, { version?: string }>;
  };
  const packages = lock.packages ?? {};
  const clientSdk = packages["node_modules/@modelcontextprotocol/client"]?.version ?? null;
  const serverSdk = packages["node_modules/@modelcontextprotocol/server"]?.version ?? null;
  const zod = [
    ...new Set(
      Object.entries(packages)
        .filter(([name]) => name === "node_modules/zod" || name.endsWith("/node_modules/zod"))
        .map(([, value]) => value.version)
        .filter((version): version is string => Boolean(version)),
    ),
  ].sort();
  return { clientSdk, serverSdk, zod };
}

function redactHome(value: string): string {
  const home = homedir();
  return value === home || value.startsWith(`${home}${path.sep}`) ? `$HOME${value.slice(home.length)}` : value;
}

async function readBuiltinMcpSettings(): Promise<{ enabled: boolean; port: number }> {
  let enabled = false;
  let port = 6298;
  const root = path.join(homedir(), ".freeplane");
  if (!(await exists(root))) return { enabled, port };

  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const propertiesPath = path.join(root, entry.name, "auto.properties");
    if (!(await exists(propertiesPath))) continue;
    const properties = await readFile(propertiesPath, "utf8");
    enabled = /^ai_mcp_server_enabled\s*=\s*true\s*$/m.test(properties) || enabled;
    const matchedPort = /^ai_mcp_server_port\s*=\s*(\d+)\s*$/m.exec(properties)?.[1];
    if (matchedPort) port = Number(matchedPort);
  }
  return { enabled, port };
}

async function isPortListening(port: number): Promise<boolean> {
  const { connect } = await import("node:net");
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(150, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function check(id: string, condition: boolean, pass: string, fail: string): ProbeCheck {
  return { id, status: condition ? "pass" : "fail", evidence: condition ? pass : fail };
}

function capabilities(
  version: string,
  reportId: string,
  checks: ProbeCheck[],
  menuActions: Set<string>,
): Capability[] {
  const passed = new Set(checks.filter((item) => item.status === "pass").map((item) => item.id));
  const future = (
    capability_id: string,
    scope: Capability["scope"],
    route: Capability["route"],
    risk: Capability["risk"],
    requirements: string[],
  ): Capability => ({
    capability_id,
    scope,
    route,
    risk,
    status: requirements.every((requirement) => passed.has(requirement) || menuActions.has(requirement))
      ? "needs_validation"
      : "unsupported",
    freeplane_version: version,
    qualification_report: reportId,
    evidence: requirements,
  });

  return [
    {
      capability_id: "runtime.status",
      scope: "read",
      route: "file",
      risk: "normal",
      status: "file_read",
      freeplane_version: version,
      qualification_report: reportId,
      evidence: ["build.fingerprint", "protocol.static_compatibility"],
    },
    {
      capability_id: "runtime.capabilities",
      scope: "read",
      route: "file",
      risk: "normal",
      status: "file_read",
      freeplane_version: version,
      qualification_report: reportId,
      evidence: ["menu.inventory", "class.public.controller"],
    },
    future("map.read", "read", "public_api", "normal", ["class.public.controller", "class.public.mind_map"]),
    future("node.read", "read", "public_api", "normal", ["class.public.node"]),
    future("node.update_text", "edit", "internal_api", "normal", [
      "class.public.node",
      "class.internal.transaction_controller",
      "class.internal.undo_handler",
    ]),
    future("summary.create", "edit", "internal_api", "normal", [
      "class.internal.transaction_controller",
      "NewSummaryAction",
    ]),
    future("document.lifecycle", "document", "public_api", "confirm", [
      "class.public.controller",
      "class.public.mind_map",
    ]),
    future("export.basic", "export", "menu", "confirm", ["ExportAction"]),
    future("presentation.navigate", "gui", "menu", "normal", [
      "StartPresentationAction",
      "StopPresentationAction",
      "ShowNextSlideAction",
      "ShowPreviousSlideAction",
    ]),
    future("print.preview", "gui", "menu", "normal", ["PrintPreviewAction"]),
  ];
}

export async function runProbe(options: ProbeOptions = {}): Promise<ProbeResult> {
  const baselinePath =
    options.baselinePath ??
    process.env.FREEPLANE_MCP_BASELINE ??
    path.resolve("qualification/baselines/freeplane-1.13.3.json");
  const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as Baseline;
  if (baseline.schema_version !== 1 || !SHA256.test(baseline.build_fingerprint)) {
    throw new Error(`Invalid qualification baseline: ${baselinePath}`);
  }

  const app = await discoverFreeplaneApp(options.freeplaneApp);
  const infoPlist = path.join(app, "Contents/Info.plist");
  const bundleIdentifier = await plistValue(infoPlist, "CFBundleIdentifier");
  const version = await plistValue(infoPlist, "CFBundleShortVersionString");
  const java = path.join(app, "Contents/runtime/Contents/Home/bin/java");
  const javap = path.join(app, "Contents/runtime/Contents/Home/bin/javap");
  const artifacts = await Promise.all(
    baseline.artifacts.map(async (artifact) => ({
      relative_path: artifact.relative_path,
      ...(await sha256File(path.join(app, artifact.relative_path))),
    })),
  );
  const fingerprint = buildFingerprint(artifacts);
  const menu = await inspectMenus(app, baseline);
  const classChecks = await Promise.all(
    baseline.class_probes.map((classProbe) => inspectClass(app, javap, classProbe)),
  );
  const codex = await findCodex();
  const lockedDependencies = await lockedDependencyVersions();
  const builtinSettings = await readBuiltinMcpSettings();
  const reportId = `v0.0a-${fingerprint.slice(0, 12)}`;
  const requiredActions = new Set(menu.required_actions_present);

  const artifactMismatches = artifacts.filter(
    (artifact) =>
      baseline.artifacts.find((expected) => expected.relative_path === artifact.relative_path)?.sha256 !==
      artifact.sha256,
  );
  const menuMatches =
    menu.entry_count === baseline.menu_inventory.entry_count &&
    menu.unique_name_count === baseline.menu_inventory.unique_name_count &&
    menu.action_entry_count === baseline.menu_inventory.action_entry_count &&
    menu.unique_action_count === baseline.menu_inventory.unique_action_count &&
    menu.required_actions_present.length === baseline.menu_inventory.required_actions.length;
  const checks: ProbeCheck[] = [
    check(
      "runtime.node22",
      Number(process.versions.node.split(".")[0]) === 22,
      `Node ${process.versions.node}`,
      `Expected Node 22, found ${process.versions.node}`,
    ),
    check(
      "bundle.identity",
      bundleIdentifier === baseline.bundle_identifier && version === baseline.freeplane_version,
      `${bundleIdentifier} ${version}`,
      `Expected ${baseline.bundle_identifier} ${baseline.freeplane_version}, found ${bundleIdentifier} ${version}`,
    ),
    check(
      "build.fingerprint",
      artifactMismatches.length === 0 && fingerprint === baseline.build_fingerprint,
      `${artifacts.length} artifacts matched ${fingerprint}`,
      `Fingerprint mismatch: ${artifactMismatches.map((item) => item.relative_path).join(", ") || fingerprint}`,
    ),
    check(
      "protocol.static_compatibility",
      SUPPORTED_PROTOCOL_VERSIONS.includes(baseline.protocol_revision) &&
        codex.embedded_protocol_revisions.includes(baseline.protocol_revision),
      `SDK and local Codex contain ${baseline.protocol_revision}`,
      `No static evidence that both SDK and local Codex contain ${baseline.protocol_revision}`,
    ),
    check(
      "dependency.sdk_locked",
      lockedDependencies.clientSdk === baseline.mcp_sdk_version &&
        lockedDependencies.serverSdk === baseline.mcp_sdk_version,
      `@modelcontextprotocol client/server ${baseline.mcp_sdk_version}`,
      `Expected MCP client/server ${baseline.mcp_sdk_version}, found ${lockedDependencies.clientSdk ?? "none"}/${lockedDependencies.serverSdk ?? "none"}`,
    ),
    check(
      "dependency.zod_singleton",
      lockedDependencies.zod.length === 1 && lockedDependencies.zod[0] === baseline.zod_version,
      `single Zod ${lockedDependencies.zod[0]}`,
      `Expected one Zod ${baseline.zod_version}, found ${lockedDependencies.zod.join(", ") || "none"}`,
    ),
    check(
      "menu.inventory",
      menuMatches,
      `${menu.entry_count} entries, ${menu.unique_action_count} unique actions`,
      "Menu inventory differs from the frozen baseline",
    ),
    ...classChecks,
    {
      id: "protocol.codex_stdio_handshake",
      status: "fail",
      evidence: "Not run by the static probe",
    },
  ];
  const capabilityList = capabilities(version, reportId, checks, requiredActions);
  const generatedAt = (options.now ?? new Date()).toISOString();
  const builtinClass = classChecks.find((item) => item.id === "class.builtin.mcp");
  const report: QualificationReport = {
    schema_version: 1,
    stage: "v0.0A",
    generated_at: generatedAt,
    passed: checks.every((item) => item.status === "pass"),
    qualification_report: reportId,
    fixed_protocol_revision: baseline.protocol_revision,
    system: { platform: process.platform, arch: process.arch, node_version: process.versions.node },
    codex,
    freeplane: {
      location: redactHome(app),
      bundle_identifier: bundleIdentifier,
      version,
      bundled_java_version: await readJavaVersion(java),
      build_fingerprint: fingerprint,
      artifact_count: artifacts.length,
    },
    builtin_mcp: {
      detected: builtinClass?.status === "pass",
      enabled_setting: builtinSettings.enabled,
      port: builtinSettings.port,
      port_listening: await isPortListening(builtinSettings.port),
      protocol_revision: builtinClass?.status === "pass" ? "2024-11-05" : null,
      token_observed: false,
    },
    menu_inventory: menu,
    checks,
    capabilities: capabilityList,
  };
  const manifest = CapabilityManifestSchema.parse({
    schema_version: 1,
    generated_at: generatedAt,
    freeplane_version: version,
    freeplane_build_fingerprint: fingerprint,
    addon_version: null,
    protocol_revision: baseline.protocol_revision,
    capabilities: capabilityList,
  });
  return { report, manifest };
}

export async function writeProbeResult(result: ProbeResult, root = process.cwd()): Promise<void> {
  const reportDir = path.join(root, "qualification/reports");
  const capabilityDir = path.join(root, "qualification/capabilities");
  await Promise.all([mkdir(reportDir, { recursive: true }), mkdir(capabilityDir, { recursive: true })]);
  await Promise.all([
    writeFile(path.join(reportDir, "v0.0a-local.json"), `${JSON.stringify(result.report, null, 2)}\n`, {
      mode: 0o600,
    }),
    writeFile(path.join(capabilityDir, "capabilities.json"), `${JSON.stringify(result.manifest, null, 2)}\n`, {
      mode: 0o600,
    }),
  ]);
}
