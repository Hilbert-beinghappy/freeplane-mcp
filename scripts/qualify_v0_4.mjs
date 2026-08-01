import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
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
  ?? path.join(homedir(), "Library/Caches/Freeplane-MCP/build/v0.4");
const addonJar = path.join(buildDir, "freeplane-mcp-bridge-0.4.0.jar");
const fixtureSource = path.join(root, "fixtures/core-mm/v0.0b.mm");
const reportPath = path.join(root, "qualification/reports/v0.4-local.json");
const priorReportPath = path.join(root, "qualification/reports/v0.3-local.json");
const manifestPath = path.join(root, "qualification/capabilities/capabilities.json");
const fingerprint = "ff6dab76e60acfb0666ee8ac90dcf2df5bbb1975c2d99eab59ca3f08dcda1822";
const qualificationId = `v0.4-${fingerprint.slice(0, 12)}`;
const qualifiedCapabilities = [
  "runtime.status", "runtime.capabilities", "map.read", "node.read", "map.changes", "map.list",
  "map.selection", "map.search.literal", "map.file_read", "node.create", "node.update_text",
  "node.update_details_note", "node.attributes", "node.tags", "node.icons", "node.link",
  "node.move_reorder", "node.fold", "node.delete", "connector.edit", "transaction.atomic_compound_undo",
  "history.undo_redo", "node.clone", "summary.create", "node.free_side", "node.style", "node.layout",
  "node.cloud", "node.bookmark", "node.formula.arithmetic", "node.reminder.no_script", "view.filter.literal",
];
const documentCapabilities = ["document.lifecycle", "export.basic", "map.file_write"];
const expectedTools = [
  "freeplane_apply", "freeplane_capabilities", "freeplane_changes", "freeplane_document", "freeplane_export",
  "freeplane_history", "freeplane_list_maps", "freeplane_read", "freeplane_search", "freeplane_status",
  "freeplane_view",
];

const checks = [];
const metrics = {};
let qualificationRoot;
let child;
let discovery;
let client;
let transport;
let stderr = "";
let fatalError;
let requestSequence = 0;
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

function sanitize(value, limit = 2_000) {
  let result = String(value ?? "qualification failed");
  if (discovery?.token) result = result.replaceAll(discovery.token, "[REDACTED_TOKEN]");
  if (qualificationRoot) result = result.replaceAll(qualificationRoot, "$QUALIFICATION_TMP");
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

async function bridgeRequest(method, endpoint, body) {
  const response = await fetch(`http://${discovery.host}:${discovery.port}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${discovery.token}`,
      "X-Request-Id": `qualify-v04-${++requestSequence}`,
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, payload: JSON.parse(await response.text()) };
}

async function bridgeMust(method, endpoint, body) {
  const response = await bridgeRequest(method, endpoint, body);
  if (response.status !== 200 || response.payload.ok !== true) {
    throw new Error(`${endpoint} failed: ${response.payload.error?.category ?? response.status}: ${response.payload.error?.message ?? ""}`);
  }
  return response.payload.data;
}

async function maps() {
  return (await bridgeMust("GET", "/v1/maps")).maps;
}

async function currentMap(mapId) {
  const found = (await maps()).find((map) => map.map_id === mapId);
  if (!found) throw new Error(`map unavailable: ${mapId}`);
  return found;
}

async function readMap(mapId) {
  return bridgeMust("POST", "/v1/read", { map_id: mapId });
}

async function mcpCall(name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (!result.structuredContent || typeof result.structuredContent !== "object") {
    throw new Error(`${name} returned no structured envelope`);
  }
  return { ...result.structuredContent, isError: result.isError === true };
}

async function mcpMust(name, args) {
  const result = await mcpCall(name, args);
  if (result.isError || result.ok !== true) {
    throw new Error(`${name} failed: ${result.error?.category ?? "unknown"}: ${result.error?.message ?? ""} ${JSON.stringify(result.error?.details ?? {})}`);
  }
  return result;
}

function confirmation(result) {
  const id = result.error?.details?.confirmation_id;
  if (result.error?.category !== "CONFIRMATION_REQUIRED" || typeof id !== "string") {
    throw new Error(`expected confirmation challenge, observed ${result.error?.category ?? "success"}`);
  }
  return { confirmation_id: id, accepted: true };
}

function applyInput(map, operations, summary) {
  return {
    map_id: map.map_id,
    expected_content_revision: map.content_revision,
    expected_file_revision: null,
    expected_view_revision: null,
    idempotency_key: randomUUID(),
    dry_run: false,
    operations,
    confirmation: null,
    user_summary: summary,
  };
}

function documentInput(action, fields = {}) {
  return {
    action,
    overwrite: false,
    dry_run: false,
    idempotency_key: randomUUID(),
    confirmation: null,
    ...fields,
  };
}

function exportInput(map, destination, format) {
  return {
    map_id: map.map_id,
    scope: "map",
    root_node_id: null,
    format_id: format,
    destination,
    expected_content_revision: map.content_revision,
    overwrite: false,
    dry_run: false,
    idempotency_key: randomUUID(),
    options: {},
    confirmation: null,
  };
}

function candidateManifest(source) {
  const manifest = structuredClone(source);
  manifest.generated_at = new Date().toISOString();
  manifest.addon_version = "0.4.0";
  for (const capabilityId of qualifiedCapabilities) {
    const capability = manifest.capabilities.find((item) => item.capability_id === capabilityId);
    if (!capability) throw new Error(`inherited capability missing: ${capabilityId}`);
    capability.qualification_report = qualificationId;
  }
  for (const capabilityId of documentCapabilities) {
    let capability = manifest.capabilities.find((item) => item.capability_id === capabilityId);
    if (!capability) {
      capability = {
        capability_id: capabilityId,
        scope: "document",
        status: "needs_validation",
        route: "file",
        risk: "confirm",
        freeplane_version: "1.13.3",
        qualification_report: qualificationId,
        evidence: [],
      };
      manifest.capabilities.push(capability);
    }
    Object.assign(capability, capabilityId === "document.lifecycle"
      ? { scope: "document", status: "verified_internal_api", route: "internal_api", risk: "confirm" }
      : capabilityId === "export.basic"
        ? { scope: "export", status: "verified_internal_api", route: "internal_api", risk: "confirm" }
        : { scope: "document", status: "file_write", route: "file", risk: "normal" });
    capability.qualification_report = qualificationId;
    capability.evidence = capabilityId === "document.lifecycle"
      ? ["v0.4.lifecycle_roundtrip", "v0.4.file_conflict_confirmation"]
      : capabilityId === "export.basic"
        ? ["v0.4.export_four_formats", "v0.4.artifact_atomic_commit"]
        : ["v0.4.lexical_writeback", "v0.4.unknown_xml_xattr_backup"];
  }
  let encryption = manifest.capabilities.find((item) => item.capability_id === "node.encryption");
  if (!encryption) {
    encryption = {
      capability_id: "node.encryption",
      scope: "edit",
      status: "unsupported",
      route: "public_api",
      risk: "blocked",
      freeplane_version: "1.13.3",
      qualification_report: qualificationId,
      evidence: [],
    };
    manifest.capabilities.push(encryption);
  }
  Object.assign(encryption, {
    status: "unsupported",
    risk: "blocked",
    qualification_report: qualificationId,
    evidence: ["SECURE_INPUT_UNAVAILABLE: ordinary MCP parameters cannot carry node-encryption passwords"],
  });
  return manifest;
}

async function startMcp(candidateRoot, runtimeDir, workDir, configuredFiles) {
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "packages/server/dist/index.js")],
    cwd: candidateRoot,
    env: {
      ...getDefaultEnvironment(),
      FREEPLANE_MCP_RUNTIME_DIR: runtimeDir,
      FREEPLANE_MCP_FILES: JSON.stringify(configuredFiles),
      FREEPLANE_MCP_ALLOWED_ROOTS: JSON.stringify([workDir]),
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-65_536); });
  client = new Client(
    { name: "freeplane-mcp-v0.4-qualification", version: "0.4.0" },
    { supportedProtocolVersions: ["2025-11-25"] },
  );
  await client.connect(transport);
}

async function stopIsolatedProcess() {
  if (client) await client.close().catch(() => undefined);
  const pid = Number(discovery?.pid ?? child?.pid);
  if (Number.isInteger(pid) && pid > 1) {
    const command = await execFile("/bin/ps", ["-p", String(pid), "-o", "command="])
      .then(({ stdout }) => stdout.trim(), () => "");
    if (pid === child?.pid || command.includes(qualificationRoot)) {
      try { process.kill(pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  }
  if (child && child.exitCode === null) {
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(8_000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

try {
  process.stderr.write("v0.4: building candidate and starting isolated Freeplane\n");
  baselinePids = await freeplanePids();
  await execFile("npm", ["run", "build"], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  await execFile(process.execPath, [path.join(root, "scripts/build_addon.mjs")], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  addCheck("build.candidate", true, "TypeScript build, Java compile, JAR packaging, and BridgeSelfTest passed");

  const priorReportBytes = await readFile(priorReportPath);
  const priorReport = JSON.parse(priorReportBytes);
  inheritedReport = { stage: priorReport.stage, qualification_report: priorReport.qualification_report, sha256: sha256(priorReportBytes) };
  addCheck(
    "preservation.v0.3_gate_inherited",
    priorReport.passed === true && Object.values(priorReport.hard_gate ?? {}).every(Boolean),
    `v0.3 qualified report ${inheritedReport.sha256} remains the organization evidence base`,
  );

  qualificationRoot = await mkdtemp(path.join(tmpdir(), "freeplane-mcp-v0.4-"));
  const userRoot = path.join(qualificationRoot, "user");
  const profile = path.join(userRoot, "1.12.x");
  const runtimeDir = path.join(qualificationRoot, "runtime");
  const workDir = path.join(qualificationRoot, "work");
  const fixture = path.join(workDir, "qualification.mm");
  const template = path.join(workDir, "template.mm");
  const closedFile = path.join(workDir, "closed.mm");
  const openGuardFile = path.join(workDir, "open-guard.mm");
  const hostile = path.join(workDir, "hostile.mm");
  const outside = path.join(qualificationRoot, "outside.mm");
  const link = path.join(workDir, "link.mm");
  const candidateRoot = path.join(qualificationRoot, "candidate");
  await Promise.all([
    mkdir(path.join(profile, "lib"), { recursive: true }),
    mkdir(path.join(profile, "scripts/init"), { recursive: true }),
    mkdir(runtimeDir, { recursive: true }),
    mkdir(workDir, { recursive: true }),
    mkdir(path.join(candidateRoot, "qualification/reports"), { recursive: true }),
    mkdir(path.join(candidateRoot, "qualification/capabilities"), { recursive: true }),
  ]);
  await chmod(runtimeDir, 0o700);
  await copyFile(addonJar, path.join(profile, "lib", path.basename(addonJar)));
  await Promise.all([
    copyFile(fixtureSource, fixture),
    copyFile(fixtureSource, template),
    copyFile(fixtureSource, openGuardFile),
    copyFile(fixtureSource, outside),
  ]);
  const sourceHash = sha256(await readFile(fixtureSource));
  const closedSource = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n<!--preserve-comment--><map version="freeplane 1.13.3" xmlns:x="urn:unknown"><node ID="CLOSED_ROOT" TEXT="closed root" x:flag="preserve"><x:unknown VALUE="preserve"/><node ID="CLOSED_CHILD" TEXT='old'/></node></map>\n`),
  ]);
  await writeFile(closedFile, closedSource);
  await writeFile(hostile, `<!DOCTYPE map [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><map><node ID="ROOT" TEXT="&xxe;"/></map>`);
  await symlink(outside, link);
  await execFile("/usr/bin/xattr", ["-w", "com.freeplane-mcp.qualification", "preserve", closedFile]);
  await writeFile(path.join(profile, "auto.properties"), [
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

  const sourceManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  candidate = candidateManifest(sourceManifest);
  await writeFile(path.join(candidateRoot, "qualification/reports/v0.0a-local.json"),
    await readFile(path.join(root, "qualification/reports/v0.0a-local.json"), "utf8"));
  await writeFile(path.join(candidateRoot, "qualification/capabilities/capabilities.json"), `${JSON.stringify(candidate, null, 2)}\n`);

  child = spawn(binary, [`-U${userRoot}`, fixture], { cwd: workDir, env: process.env, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-65_536); });
  discovery = await waitFor(async () => {
    const value = JSON.parse(await readFile(path.join(runtimeDir, "bridge.json"), "utf8"));
    return value.port > 0 ? value : null;
  }, 30_000, "bridge discovery");
  addCheck(
    "isolation.bridge_identity",
    discovery.host === "127.0.0.1"
      && discovery.addon_version === "0.4.0"
      && discovery.freeplane_build_fingerprint === fingerprint
      && (await stat(runtimeDir)).mode % 0o1000 === 0o700
      && (await stat(path.join(runtimeDir, "bridge.json"))).mode % 0o1000 === 0o600,
    "isolated 0.4.0 bridge uses dynamic loopback binding and private discovery",
  );
  const initialMap = await waitFor(async () => {
    const value = await maps();
    return value.length === 1 ? value[0] : null;
  }, 20_000, "isolated map");
  const initialMapId = initialMap.map_id;

  await startMcp(candidateRoot, runtimeDir, workDir, [closedFile, openGuardFile]);
  const listedTools = (await client.listTools()).tools.map((tool) => tool.name).sort();
  addCheck("mcp.eleven_tool_surface", JSON.stringify(listedTools) === JSON.stringify(expectedTools), "exact v0.4 eleven-tool surface registered");
  const status = await mcpMust("freeplane_status", {});
  addCheck(
    "mcp.qualification_identity",
    status.data.qualification_report === qualificationId
      && status.data.qualification_passed === true
      && status.data.bridge.addon_version === "0.4.0",
    "candidate manifest, server, bridge, and protocol identity agree",
  );

  const firstRead = await readMap(initialMapId);
  const rootId = firstRead.content.root.id;
  await mcpMust("freeplane_apply", applyInput(
    await currentMap(initialMapId),
    [{ op: "update_content", node_id: rootId, text: "v0.4 qualified saved state" }],
    "Prepare lifecycle save qualification",
  ));
  const originalDiskHash = sha256(await readFile(fixture));
  await writeFile(fixture, Buffer.concat([await readFile(fixture), Buffer.from("\n<!--external-change-->\n")]));
  const dirtyMap = await currentMap(initialMapId);
  const conflictInput = documentInput("save", {
    map_id: initialMapId,
    expected_content_revision: dirtyMap.content_revision,
    expected_file_revision: originalDiskHash,
  });
  const conflict = await mcpCall("freeplane_document", conflictInput);
  addCheck("document.external_conflict", conflict.error?.category === "FILE_CONFLICT", "external disk revision is rejected before save");
  const overwriteInput = { ...conflictInput, overwrite: true, idempotency_key: randomUUID() };
  const overwriteChallenge = await mcpCall("freeplane_document", overwriteInput);
  const saved = await mcpMust("freeplane_document", { ...overwriteInput, confirmation: confirmation(overwriteChallenge) });
  addCheck(
    "document.external_conflict_confirmation",
    saved.effect_status === "verified" && saved.data.map.dirty === false
      && saved.data.map.file_identity.sha256 === sha256(await readFile(fixture)),
    "bound confirmation overwrote only the observed external revision and returned file hash readback",
  );

  const exportMap = await currentMap(initialMapId);
  for (const format of ["png", "pdf", "svg", "html"]) {
    const exported = await mcpMust("freeplane_export", exportInput(exportMap, path.join(workDir, `map.${format}`), format));
    addCheck(
      `export.${format}`,
      exported.effect_status === "verified"
        && exported.evidence.artifact?.sha256 === sha256(await readFile(path.join(workDir, `map.${format}`)))
        && exported.evidence.artifact?.size > 0,
      `${format.toUpperCase()} artifact passed native export, magic/structure, and hash verification`,
    );
  }
  const pngOverwrite = { ...exportInput(exportMap, path.join(workDir, "map.png"), "png"), overwrite: true };
  const exportChallenge = await mcpCall("freeplane_export", pngOverwrite);
  const overwritten = await mcpMust("freeplane_export", { ...pngOverwrite, confirmation: confirmation(exportChallenge) });
  addCheck(
    "export.overwrite_confirmation_backup",
    typeof overwritten.data.artifact.backupId === "string"
      && (await stat(path.join(runtimeDir, "backups", overwritten.data.artifact.backupId, "original.png"))).isFile(),
    "export overwrite was revision-bound and retained a private original artifact backup",
  );

  await mcpMust("freeplane_apply", applyInput(
    await currentMap(initialMapId),
    [{ op: "update_content", node_id: rootId, text: "saved by save_then_close" }],
    "Prepare dirty close qualification",
  ));
  const beforeClose = await currentMap(initialMapId);
  const closeBase = documentInput("close", {
    map_id: initialMapId,
    close_mode: "cancel",
    expected_content_revision: beforeClose.content_revision,
    expected_file_revision: sha256(await readFile(fixture)),
  });
  const cancelled = await mcpMust("freeplane_document", closeBase);
  addCheck("document.close_cancel", cancelled.effect_status === "none" && (await currentMap(initialMapId)).dirty === true, "cancel kept the dirty map open with zero effect");
  const saveCloseInput = { ...closeBase, close_mode: "save_then_close", idempotency_key: randomUUID() };
  const saveCloseChallenge = await mcpCall("freeplane_document", saveCloseInput);
  const saveClosed = await mcpMust("freeplane_document", { ...saveCloseInput, confirmation: confirmation(saveCloseChallenge) });
  addCheck(
    "document.close_save_then_close",
    saveClosed.data.closed === true && !(await maps()).some((map) => map.map_id === initialMapId)
      && (await readFile(fixture, "utf8")).includes("saved by save_then_close"),
    "dirty save_then_close required confirmation, persisted content, and removed the map from the registry",
  );

  const saveAsTarget = path.join(workDir, "created.mm");
  await copyFile(template, saveAsTarget);
  const created = await mcpMust("freeplane_document", documentInput("create"));
  const createdMap = created.data.map;
  const targetRevision = sha256(await readFile(saveAsTarget));
  const saveAsBase = documentInput("save_as", {
    map_id: createdMap.map_id,
    path: saveAsTarget,
    expected_content_revision: createdMap.content_revision,
    expected_file_revision: targetRevision,
  });
  const saveAsConflict = await mcpCall("freeplane_document", saveAsBase);
  addCheck("document.save_as_conflict", saveAsConflict.error?.category === "FILE_CONFLICT", "existing save_as target requires explicit overwrite intent");
  const saveAsOverwrite = { ...saveAsBase, overwrite: true, idempotency_key: randomUUID() };
  const saveAsChallenge = await mcpCall("freeplane_document", saveAsOverwrite);
  const savedAs = await mcpMust("freeplane_document", { ...saveAsOverwrite, confirmation: confirmation(saveAsChallenge) });
  const savedAsMap = savedAs.data.map;
  const savedAsHash = sha256(await readFile(saveAsTarget));
  addCheck("document.create_save_as", savedAsMap.dirty === false && savedAsMap.file_identity.sha256 === savedAsHash, "new document replaced a confirmed target with exact file hash readback");

  const createdRoot = (await readMap(savedAsMap.map_id)).content.root.id;
  await mcpMust("freeplane_apply", applyInput(
    await currentMap(savedAsMap.map_id),
    [{ op: "update_content", node_id: createdRoot, text: "discarded by revert" }],
    "Prepare revert qualification",
  ));
  const revertMap = await currentMap(savedAsMap.map_id);
  const revertInput = documentInput("revert", {
    map_id: savedAsMap.map_id,
    expected_content_revision: revertMap.content_revision,
    expected_file_revision: savedAsHash,
  });
  const revertChallenge = await mcpCall("freeplane_document", revertInput);
  const reverted = await mcpMust("freeplane_document", { ...revertInput, confirmation: confirmation(revertChallenge) });
  const revertedMap = reverted.data.map;
  addCheck(
    "document.revert",
    sha256(await readFile(saveAsTarget)) === savedAsHash
      && !(await readMap(revertedMap.map_id)).content.root.text.includes("discarded by revert"),
    "revert discarded unsaved state and reopened the exact confirmed disk revision",
  );
  await mcpMust("freeplane_document", documentInput("close", {
    map_id: revertedMap.map_id,
    close_mode: "discard_then_close",
    expected_content_revision: revertedMap.content_revision,
    expected_file_revision: savedAsHash,
  }));

  const templated = await mcpMust("freeplane_document", documentInput("create_from_template", { template_path: template }));
  const templateMap = templated.data.map;
  const templateRoot = (await readMap(templateMap.map_id)).content.root.id;
  await mcpMust("freeplane_apply", applyInput(
    await currentMap(templateMap.map_id),
    [{ op: "update_content", node_id: templateRoot, text: "discard template copy" }],
    "Prepare discard close qualification",
  ));
  const dirtyTemplate = await currentMap(templateMap.map_id);
  const discardInput = documentInput("close", {
    map_id: templateMap.map_id,
    close_mode: "discard_then_close",
    expected_content_revision: dirtyTemplate.content_revision,
    expected_file_revision: null,
  });
  const discardChallenge = await mcpCall("freeplane_document", discardInput);
  const discarded = await mcpMust("freeplane_document", { ...discardInput, confirmation: confirmation(discardChallenge) });
  addCheck(
    "document.template_discard_close",
    discarded.data.closed === true && sha256(await readFile(template)) === sourceHash,
    "template copy was isolated and dirty discard_then_close required confirmation",
  );

  const opened = await mcpMust("freeplane_document", documentInput("open", { path: fixture }));
  const openedMap = opened.data.map;
  await mcpMust("freeplane_document", documentInput("close", {
    map_id: openedMap.map_id,
    close_mode: "discard_then_close",
    expected_content_revision: openedMap.content_revision,
    expected_file_revision: sha256(await readFile(fixture)),
  }));
  addCheck("document.open_close", !(await maps()).some((map) => map.map_id === openedMap.map_id), "qualified open entered and clean close left the registry");

  const closedCanonical = await realpath(closedFile);
  const closedMapId = `file:${sha256(closedCanonical)}`;
  const beforeClosedHash = sha256(await readFile(closedFile));
  const fileWrite = await mcpMust("freeplane_apply", {
    map_id: closedMapId,
    expected_content_revision: 0,
    expected_file_revision: beforeClosedHash,
    expected_view_revision: null,
    idempotency_key: randomUUID(),
    dry_run: false,
    operations: [{ op: "update_content", node_id: "CLOSED_CHILD", text: "new & 'quoted' <value>" }],
    confirmation: null,
    user_summary: "Qualify lexical closed-file TEXT writeback",
  });
  const expectedClosed = Buffer.from(closedSource.toString("utf8").replace(
    "TEXT='old'",
    "TEXT='new &amp; &apos;quoted&apos; &lt;value&gt;'",
  ));
  const fileBackup = path.join(runtimeDir, "backups", fileWrite.data.backup_id);
  addCheck(
    "file_write.lexical_unknown_xml_xattr_backup",
    (await readFile(closedFile)).equals(expectedClosed)
      && (await readFile(path.join(fileBackup, "original.mm"))).equals(closedSource)
      && (await readFile(path.join(fileBackup, "candidate.mm"))).equals(expectedClosed)
      && (await execFile("/usr/bin/xattr", ["-p", "com.freeplane-mcp.qualification", closedFile])).stdout.trim() === "preserve",
    "only target TEXT bytes changed; BOM, comment, namespace, unknown XML, backup pair, and xattr were preserved",
  );

  const openGuardCanonical = await realpath(openGuardFile);
  const openGuardMapId = `file:${sha256(openGuardCanonical)}`;
  const openGuardHash = sha256(await readFile(openGuardFile));
  const openedClosed = await mcpMust("freeplane_document", documentInput("open", { path: openGuardFile }));
  const openWrite = await mcpCall("freeplane_apply", {
    map_id: openGuardMapId,
    expected_content_revision: 0,
    expected_file_revision: openGuardHash,
    expected_view_revision: null,
    idempotency_key: randomUUID(),
    dry_run: false,
    operations: [{ op: "update_content", node_id: rootId, text: "must not write" }],
    confirmation: null,
    user_summary: "Reject writeback while file is open",
  });
  addCheck("file_write.open_map_guard", openWrite.error?.category === "FILE_CONFLICT", "closed-file route rejects a path currently open in Freeplane");
  await mcpMust("freeplane_document", documentInput("close", {
    map_id: openedClosed.data.map.map_id,
    close_mode: "discard_then_close",
    expected_content_revision: openedClosed.data.map.content_revision,
    expected_file_revision: openGuardHash,
  }));

  const hostileOpen = await mcpCall("freeplane_document", documentInput("open", { path: hostile }));
  const linkOpen = await mcpCall("freeplane_document", documentInput("open", { path: link }));
  const outsideOpen = await mcpCall("freeplane_document", documentInput("open", { path: outside }));
  addCheck(
    "policy.path_xxe_matrix",
    hostileOpen.error?.category === "XML_UNSAFE"
      && linkOpen.error?.category === "PATH_DENIED"
      && outsideOpen.error?.category === "PATH_DENIED",
    "DTD/XXE, symlink, and outside-root document opens are rejected before Freeplane",
  );
  const toolsJson = JSON.stringify(await client.listTools());
  addCheck(
    "policy.encryption_secure_input_blocked",
    candidate.capabilities.find((item) => item.capability_id === "node.encryption")?.status === "unsupported"
      && !/password|passphrase|secret_value/i.test(toolsJson),
    "node encryption remains unsupported because no qualified secret-input field exists",
  );
  addCheck("isolation.source_fixture_unchanged", sha256(await readFile(fixtureSource)) === sourceHash, "repository fixture bytes were untouched");
  addCheck(
    "mcp.stderr_private",
    !stderr.includes(discovery.token) && !stderr.includes("new & 'quoted' <value>"),
    "MCP and Freeplane stderr contain no token or closed-map text",
  );
} catch (error) {
  fatalError = error;
  checks.push({ id: "qualification.fatal", status: "fail", evidence: sanitize(error.message) });
} finally {
  try {
    await stopIsolatedProcess();
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
  stage: "v0.4",
  generated_at: new Date().toISOString(),
  passed,
  qualification_report: qualificationId,
  freeplane: { version: "1.13.3", build_fingerprint: fingerprint },
  addon_version: "0.4.0",
  server_version: "0.4.0",
  inherited_qualification_reports: inheritedReport ? [inheritedReport] : [],
  checks,
  metrics,
  hard_gate: {
    exact_tool_surface: checks.some((check) => check.id === "mcp.eleven_tool_surface" && check.status === "pass"),
    lifecycle_roundtrip: [
      "document.close_save_then_close", "document.create_save_as", "document.revert",
      "document.template_discard_close", "document.open_close",
    ].every((id) => checks.some((check) => check.id === id && check.status === "pass")),
    conflicts_and_confirmation: [
      "document.external_conflict_confirmation", "document.save_as_conflict", "export.overwrite_confirmation_backup",
    ].every((id) => checks.some((check) => check.id === id && check.status === "pass")),
    four_verified_exports: ["png", "pdf", "svg", "html"]
      .every((format) => checks.some((check) => check.id === `export.${format}` && check.status === "pass")),
    lexical_file_write: checks.some((check) => check.id === "file_write.lexical_unknown_xml_xattr_backup" && check.status === "pass"),
    open_file_write_denied: checks.some((check) => check.id === "file_write.open_map_guard" && check.status === "pass"),
    path_and_xxe_denied: checks.some((check) => check.id === "policy.path_xxe_matrix" && check.status === "pass"),
    encryption_secure_input_blocked: checks.some((check) => check.id === "policy.encryption_secure_input_blocked" && check.status === "pass"),
    user_process_preserved: checks.some((check) => check.id === "isolation.user_process_preserved" && check.status === "pass"),
  },
};
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
if (passed && Object.values(report.hard_gate).every(Boolean)) {
  await writeFile(manifestPath, `${JSON.stringify(candidate, null, 2)}\n`);
}
if (qualificationRoot) await rm(qualificationRoot, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({ passed, report: path.relative(root, reportPath), checks: checks.length, metrics })}\n`);
if (!passed || !Object.values(report.hard_gate).every(Boolean)) process.exitCode = 1;
