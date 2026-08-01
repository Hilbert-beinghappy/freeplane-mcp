import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";

const execFile = promisify(execFileCallback);
const root = process.cwd();
const app = process.env.FREEPLANE_APP ?? "/Applications/Freeplane.app";
const binary = path.join(app, "Contents/MacOS/Freeplane");
const buildDir = process.env.FREEPLANE_MCP_BUILD_DIR
  ?? path.join(homedir(), "Library/Caches/Freeplane-MCP/build/v0.5");
const addonJar = path.join(buildDir, "freeplane-mcp-bridge-0.5.0.jar");
const axBuildDir = process.env.FREEPLANE_MCP_AX_BUILD_DIR
  ?? path.join(homedir(), "Library/Caches/Freeplane-MCP/ax-helper/v0.5");
const axHelper = path.join(axBuildDir, "freeplane-mcp-ax-helper");
const fixtureSource = path.join(root, "fixtures/core-mm/v0.0b.mm");
const priorReportPath = path.join(root, "qualification/reports/v0.4-local.json");
const reportPath = path.join(root, "qualification/reports/v0.5-local.json");
const manifestPath = path.join(root, "qualification/capabilities/capabilities.json");
const fingerprint = "ff6dab76e60acfb0666ee8ac90dcf2df5bbb1975c2d99eab59ca3f08dcda1822";
const qualificationId = `v0.5-${fingerprint.slice(0, 12)}`;
const expectedTools = [
  "freeplane_apply", "freeplane_capabilities", "freeplane_changes", "freeplane_document", "freeplane_export",
  "freeplane_history", "freeplane_invoke_action", "freeplane_list_maps", "freeplane_read", "freeplane_search",
  "freeplane_status", "freeplane_view",
];
const inheritedStatuses = new Set([
  "verified_public_api", "verified_internal_api", "file_read", "file_write", "unsupported",
]);
const checks = [];
let qualificationRoot;
let fatalError;
let inheritedReport;
let candidate;
let baselinePids = [];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function addCheck(id, passed, evidence) {
  checks.push({ id, status: passed ? "pass" : "fail", evidence });
  if (!passed) throw new Error(`${id}: ${evidence}`);
}

function sanitize(value, temporary = qualificationRoot, limit = 2_000) {
  let result = String(value ?? "qualification failed");
  if (temporary) result = result.replaceAll(temporary, "$QUALIFICATION_TMP");
  return result.replaceAll(homedir(), "$HOME").slice(0, limit);
}

async function waitFor(action, timeoutMilliseconds, description) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await action();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`${description} timed out${lastError ? `: ${sanitize(lastError.message)}` : ""}`);
}

async function freeplanePids() {
  const { stdout } = await execFile("/bin/ps", ["-ax", "-o", "pid=,command="]);
  return stdout.split("\n")
    .filter((line) => line.includes("/Applications/Freeplane.app/Contents/MacOS/Freeplane"))
    .map((line) => Number(/^\s*(\d+)/.exec(line)?.[1]))
    .filter((pid) => Number.isInteger(pid) && pid > 1);
}

async function frontmostPid() {
  const { stdout } = await execFile("/usr/bin/osascript", [
    "-e", "tell application \"System Events\" to get unix id of first application process whose frontmost is true",
  ]);
  return Number(stdout.trim());
}

async function activateFinder() {
  await execFile("/usr/bin/osascript", ["-e", "tell application \"Finder\" to activate"]);
}

function candidateManifest(source) {
  const manifest = structuredClone(source);
  manifest.generated_at = new Date().toISOString();
  manifest.addon_version = "0.5.0";
  for (const capability of manifest.capabilities) {
    if (inheritedStatuses.has(capability.status)) capability.qualification_report = qualificationId;
  }
  for (const capabilityId of ["presentation.navigate", "print.preview"]) {
    const capability = manifest.capabilities.find((item) => item.capability_id === capabilityId);
    if (!capability) throw new Error(`GUI capability is missing: ${capabilityId}`);
    Object.assign(capability, {
      scope: "gui",
      status: "verified_gui",
      route: "gui",
      risk: "normal",
      qualification_report: qualificationId,
      evidence: capabilityId === "presentation.navigate"
        ? ["v0.5.bilingual_presentation", "v0.5.bridge_state_readback"]
        : ["v0.5.bilingual_print_preview", "v0.5.dialog_cancel_readback"],
    });
  }
  const explicitCuts = [
    ["map.import.modal", "Destructive modal imports lack a qualified deterministic postcondition"],
    ["map.encryption", "No qualified secure secret-input channel exists"],
    ["print.final", "Final printer submission requires per-operation interactive confirmation"],
    ["preferences.modal", "No high-value preference workflow passed the bilingual modal gate"],
  ];
  for (const [capabilityId, reason] of explicitCuts) {
    let capability = manifest.capabilities.find((item) => item.capability_id === capabilityId);
    if (!capability) {
      capability = {
        capability_id: capabilityId,
        scope: "gui",
        status: "unsupported",
        route: "gui",
        risk: "blocked",
        freeplane_version: "1.13.3",
        qualification_report: qualificationId,
        evidence: [],
      };
      manifest.capabilities.push(capability);
    }
    Object.assign(capability, {
      status: "unsupported",
      route: "gui",
      risk: "blocked",
      qualification_report: qualificationId,
      evidence: [reason],
    });
  }
  return manifest;
}

async function runLocale(locale, expectedLocale, candidateRoot) {
  const localeRoot = path.join(qualificationRoot, locale);
  const userRoot = path.join(localeRoot, "user");
  const profile = path.join(userRoot, "1.12.x");
  const runtimeDir = path.join(localeRoot, "runtime");
  const workDir = path.join(localeRoot, "work");
  const fixture = path.join(workDir, "qualification.mm");
  let child;
  let discovery;
  let client;
  let transport;
  let stderr = "";
  let requestSequence = 0;

  const bridgeRequest = async (method, endpoint, body) => {
    try {
      const response = await fetch(`http://${discovery.host}:${discovery.port}${endpoint}`, {
        method,
        headers: {
          Authorization: `Bearer ${discovery.token}`,
          "X-Request-Id": `qualify-v05-${locale}-${++requestSequence}`,
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      });
      return { status: response.status, payload: JSON.parse(await response.text()) };
    } catch (error) {
      throw new Error(`${endpoint} transport failed: ${error.cause?.message ?? error.message}; stderr=${stderr.slice(-4_000)}`);
    }
  };
  const bridgeMust = async (method, endpoint, body) => {
    const response = await bridgeRequest(method, endpoint, body);
    if (response.status !== 200 || response.payload.ok !== true) {
      throw new Error(`${endpoint}: ${response.payload.error?.category ?? response.status}: ${response.payload.error?.message ?? ""}`);
    }
    return response.payload.data;
  };
  const mcpCall = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    return result.structuredContent && typeof result.structuredContent === "object"
      ? { ...result.structuredContent, isError: result.isError === true }
      : { isError: result.isError === true, raw: result };
  };
  const mcpMust = async (name, args) => {
    const result = await mcpCall(name, args);
    if (result.isError || result.ok !== true) {
      throw new Error(`${name}: ${result.error?.category ?? "unknown"}: ${result.error?.message ?? ""}`);
    }
    return result;
  };
  const state = async () => bridgeMust("POST", "/v1/gui-state", { map_id: mapId });
  const actionInput = async (capabilityId, action, dryRun = false) => {
    const current = await state();
    return {
      capability_id: capabilityId,
      action,
      map_id: mapId,
      expected_content_revision: current.content_revision,
      expected_view_revision: current.view_revision,
      dry_run: dryRun,
      idempotency_key: randomUUID(),
      confirmation: null,
    };
  };
  const invoke = async (capabilityId, action) => mcpMust(
    "freeplane_invoke_action",
    await actionInput(capabilityId, action),
  );
  let mapId;

  try {
    await Promise.all([
      mkdir(path.join(profile, "lib"), { recursive: true }),
      mkdir(path.join(profile, "scripts/init"), { recursive: true }),
      mkdir(runtimeDir, { recursive: true }),
      mkdir(workDir, { recursive: true }),
    ]);
    await chmod(runtimeDir, 0o700);
    await copyFile(addonJar, path.join(profile, "lib", path.basename(addonJar)));
    await copyFile(fixtureSource, fixture);
    await writeFile(path.join(profile, "auto.properties"), [
      `language=${locale}`,
      "execute_scripts_without_asking=true",
      "execute_scripts_without_file_restriction=true",
      "execute_scripts_without_network_restriction=true",
      "execute_scripts_without_write_restriction=true",
      "execute_scripts_without_exec_restriction=false",
      "check_updates_automatically=false",
      "",
    ].join("\n"));
    await writeFile(path.join(profile, "scripts/init/00-freeplane-mcp.groovy"), [
      "import org.freeplanemcp.bridge.FreeplaneBridge",
      `FreeplaneBridge.start((org.freeplane.api.Controller)c, ${JSON.stringify(runtimeDir)}, true, ${JSON.stringify(fingerprint)})`,
      "",
    ].join("\n"));

    child = spawn(binary, [`-U${userRoot}`, fixture], {
      cwd: workDir,
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-65_536); });
    discovery = await waitFor(async () => {
      const value = JSON.parse(await readFile(path.join(runtimeDir, "bridge.json"), "utf8"));
      return value.port > 0 ? value : null;
    }, 30_000, `${locale} bridge discovery`);
    addCheck(
      `${locale}.isolation_identity`,
      discovery.addon_version === "0.5.0"
        && discovery.freeplane_build_fingerprint === fingerprint
        && !baselinePids.includes(discovery.pid),
      `${locale} uses a distinct isolated 0.5.0 bridge`,
    );
    const maps = await waitFor(async () => {
      const value = await bridgeMust("GET", "/v1/maps");
      return value.maps.length === 1 ? value.maps : null;
    }, 20_000, `${locale} map`);
    mapId = maps[0].map_id;

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, "packages/server/dist/index.js")],
      cwd: candidateRoot,
      env: {
        ...getDefaultEnvironment(),
        FREEPLANE_MCP_RUNTIME_DIR: runtimeDir,
        FREEPLANE_MCP_FILES: "[]",
        FREEPLANE_MCP_ALLOWED_ROOTS: JSON.stringify([workDir]),
        FREEPLANE_MCP_AX_HELPER: axHelper,
      },
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-65_536); });
    client = new Client(
      { name: `freeplane-mcp-v0.5-${locale}`, version: "0.5.0" },
      { supportedProtocolVersions: ["2025-11-25"] },
    );
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    addCheck(
      `${locale}.twelve_tool_surface`,
      JSON.stringify(tools.map((tool) => tool.name).sort()) === JSON.stringify(expectedTools),
      `${locale} exposes the exact twelve-tool surface`,
    );
    const status = await mcpMust("freeplane_status", {});
    addCheck(
      `${locale}.qualified_identity`,
      status.data.qualification_report === qualificationId
        && status.data.qualification_passed === true
        && status.data.bridge.addon_version === "0.5.0"
        && status.data.accessibility_permission === "granted"
        && status.data.accessibility_helper?.version === "0.5.0",
      `${locale} server, bridge, manifest, and granted signed helper identity agree`,
    );

    const prepared = await bridgeMust("POST", "/v1/qualification/presentation", { map_id: mapId });
    addCheck(
      `${locale}.presentation_fixture`,
      prepared.locale === expectedLocale
        && prepared.presentation.presentation_count === 1
        && prepared.presentation.slide_count === 2
        && prepared.presentation.slide_index === 0
        && prepared.presentation.running === false,
      `${locale} isolated map has one two-slide presentation`,
    );
    const baselineContentRevision = prepared.content_revision;

    await activateFinder();
    await waitFor(async () => (await frontmostPid()) !== discovery.pid, 3_000, "Finder focus");
    const directDry = JSON.parse((await execFile(axHelper, [JSON.stringify({
      schema_version: 1,
      command: "invoke",
      pid: discovery.pid,
      expected_locale: expectedLocale,
      capability_id: "presentation.navigate",
      action: "start",
      dry_run: true,
    })])).stdout);
    const frontmostAfterDirectDry = await frontmostPid();
    addCheck(
      `${locale}.dry_run_no_focus`,
      directDry.ok === true
        && directDry.effect === "planned"
        && directDry.locale === expectedLocale
        && directDry.menu_resolution === "deferred_until_focus"
        && JSON.stringify(directDry.resolved_titles) === JSON.stringify(expectedLocale === "en"
          ? ["Navigate", "Presentation", "Run presentation"]
          : ["导航", "演示", "开始演示"])
        && directDry.frontmost_before_matches === false
        && directDry.frontmost_after_matches === false
        && frontmostAfterDirectDry !== discovery.pid,
      `${locale} dry-run ok=${String(directDry.ok)}, code=${directDry.error?.code ?? "none"}, message=${sanitize(directDry.error?.message ?? "none", qualificationRoot, 400)}, locale=${directDry.locale ?? "missing"}, effect=${directDry.effect ?? "missing"}, menu_resolution=${directDry.menu_resolution ?? "missing"}, resolved_titles=${JSON.stringify(directDry.resolved_titles ?? null)}, before=${String(directDry.frontmost_before_matches)}, after=${String(directDry.frontmost_after_matches)}, observed_frontmost_pid=${frontmostAfterDirectDry}, isolated_pid=${discovery.pid}`,
    );

    const dryInput = await actionInput("presentation.navigate", "start", true);
    const beforeDry = await state();
    const dry = await mcpMust("freeplane_invoke_action", dryInput);
    const afterDry = await state();
    addCheck(
      `${locale}.dry_run_zero_effect`,
      dry.effect_status === "planned"
        && dry.data.locale === expectedLocale
        && dry.data.menu_resolution === "deferred_until_focus"
        && JSON.stringify(beforeDry) === JSON.stringify(afterDry),
      `${locale} MCP dry-run has zero map, view, presentation, preview, or focus effect`,
    );

    const startInput = await actionInput("presentation.navigate", "start");
    const started = await mcpMust("freeplane_invoke_action", startInput);
    addCheck(
      `${locale}.focus_recovery_start`,
      started.effect_status === "verified"
        && started.data.locale === expectedLocale
        && started.data.focus_recovered === true
        && started.data.presentation.running === true
        && started.data.presentation.slide_index === 0,
      `${locale} recovered Freeplane focus and verified presentation start`,
    );
    const replayed = await mcpMust("freeplane_invoke_action", startInput);
    addCheck(
      `${locale}.idempotent_replay`,
      JSON.stringify(replayed) === JSON.stringify(started),
      `${locale} repeated action key/payload replays the persisted verified envelope`,
    );

    const next = await invoke("presentation.navigate", "next");
    const previous = await invoke("presentation.navigate", "previous");
    const last = await invoke("presentation.navigate", "last");
    const first = await invoke("presentation.navigate", "first");
    const stopped = await invoke("presentation.navigate", "stop");
    addCheck(
      `${locale}.presentation_navigation`,
      next.data.presentation.slide_index === 1
        && previous.data.presentation.slide_index === 0
        && last.data.presentation.slide_index === 1
        && first.data.presentation.slide_index === 0
        && stopped.data.presentation.running === false,
      `${locale} next, previous, last, first, and stop each passed bridge state readback`,
    );

    const previewOpened = await invoke("print.preview", "open");
    const previewClosed = await invoke("print.preview", "close");
    addCheck(
      `${locale}.preview_open_cancel`,
      previewOpened.data.locale === expectedLocale
        && previewOpened.data.print_preview_open === true
        && previewClosed.data.print_preview_open === false
        && (await state()).print_preview_open === false,
      `${locale} print preview opened by localized AX menu and closed through its AX close button`,
    );

    const current = await state();
    const stale = await mcpCall("freeplane_invoke_action", {
      ...(await actionInput("presentation.navigate", "start")),
      expected_content_revision: current.content_revision + 1,
    });
    const arbitrary = await client.callTool({
      name: "freeplane_invoke_action",
      arguments: {
        capability_id: "PrintAction",
        action: "print",
        map_id: mapId,
        expected_content_revision: current.content_revision,
        expected_view_revision: current.view_revision,
        dry_run: false,
        idempotency_key: randomUUID(),
        confirmation: true,
        menu_path: ["File", "Print"],
        x: 10,
        y: 10,
      },
    });
    addCheck(
      `${locale}.policy_and_revision`,
      stale.error?.category === "REVISION_CONFLICT"
        && arbitrary.isError === true
        && (await state()).print_preview_open === false,
      `${locale} stale revisions and arbitrary action/menu/coordinate/final-print inputs are rejected with zero GUI effect`,
    );
    addCheck(
      `${locale}.content_unchanged`,
      (await state()).content_revision === baselineContentRevision,
      `${locale} presentation and preview actions did not mutate map content`,
    );
    addCheck(
      `${locale}.private_logs`,
      !stderr.includes(discovery.token) && !stderr.includes("Freeplane MCP qualification"),
      `${locale} logs contain neither bridge token nor presentation name`,
    );
  } finally {
    if (client) await client.close().catch(() => undefined);
    const pid = Number(discovery?.pid ?? child?.pid);
    if (Number.isInteger(pid) && pid > 1) {
      const command = await execFile("/bin/ps", ["-p", String(pid), "-o", "command="])
        .then(({ stdout }) => stdout.trim(), () => "");
      if (pid === child?.pid || command.includes(localeRoot)) {
        try { process.kill(pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    }
    if (child && child.exitCode === null) {
      await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(8_000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }
}

try {
  process.stderr.write("v0.5: building candidate, signed AX helper, and bilingual isolated Freeplane profiles\n");
  baselinePids = await freeplanePids();
  await execFile("npm", ["test"], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  await execFile(process.execPath, [path.join(root, "scripts/build_addon.mjs")], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  const helperBuild = JSON.parse((await execFile(process.execPath, [path.join(root, "scripts/build_ax_helper.mjs")], {
    cwd: root,
    maxBuffer: 32 * 1024 * 1024,
  })).stdout);
  await execFile("/usr/bin/codesign", ["--verify", "--strict", axHelper]);
  addCheck(
    "build.candidate",
    helperBuild.self_test === "pass" && /^[a-f0-9]{64}$/.test(helperBuild.sha256),
    "TypeScript tests, Java self-test, Swift self-test, and ad-hoc code-signature verification passed",
  );

  const priorReportBytes = await readFile(priorReportPath);
  const priorReport = JSON.parse(priorReportBytes);
  inheritedReport = {
    stage: priorReport.stage,
    qualification_report: priorReport.qualification_report,
    sha256: sha256(priorReportBytes),
  };
  addCheck(
    "preservation.v0.4_gate_inherited",
    priorReport.passed === true && Object.values(priorReport.hard_gate ?? {}).every(Boolean),
    `v0.4 report ${inheritedReport.sha256} remains the document/export evidence base`,
  );

  qualificationRoot = await mkdtemp(path.join(tmpdir(), "freeplane-mcp-v0.5-"));
  const candidateRoot = path.join(qualificationRoot, "candidate");
  await Promise.all([
    mkdir(path.join(candidateRoot, "qualification/reports"), { recursive: true }),
    mkdir(path.join(candidateRoot, "qualification/capabilities"), { recursive: true }),
  ]);
  candidate = candidateManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  await copyFile(path.join(root, "qualification/reports/v0.0a-local.json"), path.join(candidateRoot, "qualification/reports/v0.0a-local.json"));
  await writeFile(path.join(candidateRoot, "qualification/capabilities/capabilities.json"), `${JSON.stringify(candidate, null, 2)}\n`);

  await runLocale("en", "en", candidateRoot);
  await runLocale("zh_CN", "zh_CN", candidateRoot);
  addCheck(
    "policy.explicit_gui_cuts",
    ["map.import.modal", "map.encryption", "print.final", "preferences.modal"].every((id) =>
      candidate.capabilities.find((item) => item.capability_id === id)?.status === "unsupported"),
    "destructive imports, map encryption, final printing, and preferences remain explicitly unavailable",
  );
} catch (error) {
  fatalError = error;
  checks.push({ id: "qualification.fatal", status: "fail", evidence: sanitize(error.message) });
} finally {
  try {
    const remainingPids = await freeplanePids();
    addCheck(
      "isolation.user_process_preserved",
      baselinePids.every((pid) => remainingPids.includes(pid))
        && remainingPids.every((pid) => baselinePids.includes(pid)),
      `pre-existing Freeplane PIDs preserved exactly: ${baselinePids.join(",") || "none"}`,
    );
  } catch (error) {
    fatalError ??= error;
    checks.push({ id: "isolation.cleanup", status: "fail", evidence: sanitize(error.message) });
  }
}

const passed = !fatalError && checks.length > 0 && checks.every((check) => check.status === "pass");
const report = {
  schema_version: 1,
  stage: "v0.5",
  generated_at: new Date().toISOString(),
  passed,
  qualification_report: qualificationId,
  freeplane: { version: "1.13.3", build_fingerprint: fingerprint },
  addon_version: "0.5.0",
  server_version: "0.5.0",
  helper_version: "0.5.0",
  inherited_qualification_reports: inheritedReport ? [inheritedReport] : [],
  checks,
  hard_gate: {
    exact_tool_surface: ["en", "zh_CN"].every((locale) =>
      checks.some((check) => check.id === `${locale}.twelve_tool_surface` && check.status === "pass")),
    signed_accessibility_helper: checks.some((check) => check.id === "build.candidate" && check.status === "pass"),
    bilingual_menu_resolution: ["en", "zh_CN"].every((locale) =>
      checks.some((check) => check.id === `${locale}.dry_run_no_focus` && check.status === "pass")),
    focus_recovery: ["en", "zh_CN"].every((locale) =>
      checks.some((check) => check.id === `${locale}.focus_recovery_start` && check.status === "pass")),
    presentation_readback: ["en", "zh_CN"].every((locale) =>
      checks.some((check) => check.id === `${locale}.presentation_navigation` && check.status === "pass")),
    dialog_cancel_readback: ["en", "zh_CN"].every((locale) =>
      checks.some((check) => check.id === `${locale}.preview_open_cancel` && check.status === "pass")),
    policy_rejection: ["en", "zh_CN"].every((locale) =>
      checks.some((check) => check.id === `${locale}.policy_and_revision` && check.status === "pass")),
    zero_content_mutation: ["en", "zh_CN"].every((locale) =>
      checks.some((check) => check.id === `${locale}.content_unchanged` && check.status === "pass")),
    explicit_gui_cuts: checks.some((check) => check.id === "policy.explicit_gui_cuts" && check.status === "pass"),
    user_process_preserved: checks.some((check) => check.id === "isolation.user_process_preserved" && check.status === "pass"),
  },
};
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
if (passed && Object.values(report.hard_gate).every(Boolean)) {
  await writeFile(manifestPath, `${JSON.stringify(candidate, null, 2)}\n`);
}
if (qualificationRoot && !(fatalError && process.env.FREEPLANE_MCP_KEEP_FAILED_QUALIFICATION === "1")) {
  await rm(qualificationRoot, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify({ passed, report: path.relative(root, reportPath), checks: checks.length })}\n`);
if (!passed || !Object.values(report.hard_gate).every(Boolean)) process.exitCode = 1;
