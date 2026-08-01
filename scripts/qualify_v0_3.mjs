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
  ?? path.join(homedir(), "Library/Caches/Freeplane-MCP/build/v0.3");
const addonJar = path.join(buildDir, "freeplane-mcp-bridge-0.3.0.jar");
const fixtureSource = path.join(root, "fixtures/core-mm/v0.0b.mm");
const reportPath = path.join(root, "qualification/reports/v0.3-local.json");
const priorReportPath = path.join(root, "qualification/reports/v0.2-local.json");
const manifestPath = path.join(root, "qualification/capabilities/capabilities.json");
const fingerprint = "ff6dab76e60acfb0666ee8ac90dcf2df5bbb1975c2d99eab59ca3f08dcda1822";
const qualificationId = `v0.3-${fingerprint.slice(0, 12)}`;
const readCapabilities = [
  "runtime.status", "runtime.capabilities", "map.read", "node.read", "map.changes",
  "map.list", "map.selection", "map.search.literal", "map.file_read",
];
const writeCapabilities = [
  "node.create", "node.update_text", "node.update_details_note", "node.attributes",
  "node.tags", "node.icons", "node.link", "node.move_reorder", "node.fold",
  "node.delete", "connector.edit", "transaction.atomic_compound_undo", "history.undo_redo",
];
const organizeCapabilities = [
  "node.clone", "summary.create", "node.free_side", "node.style", "node.layout",
  "node.cloud", "node.bookmark", "node.formula.arithmetic", "node.reminder.no_script",
  "view.filter.literal",
];
const expectedTools = [
  "freeplane_apply", "freeplane_capabilities", "freeplane_changes", "freeplane_history",
  "freeplane_list_maps", "freeplane_read", "freeplane_search", "freeplane_status", "freeplane_view",
];
const sectionLabels = [
  "Ⅰ 数据基础：我们现在有什么",
  "Ⅱ 数据特点：能测量什么",
  "Ⅲ 核心监管证据链",
  "Ⅳ 延伸研究方向",
  "Ⅴ 最终裁决与补数",
];
const colors = ["#DDEBF7", "#E2F0D9", "#FFF2CC", "#FCE4D6", "#E4DFEC"];

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

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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

function firstDifference(expected, actual, location = "$") {
  if (Object.is(expected, actual)) return null;
  if (expected === null || actual === null || typeof expected !== "object" || typeof actual !== "object") {
    return `${location}: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}`.slice(0, 1_000);
  }
  if (Array.isArray(expected) !== Array.isArray(actual)) return `${location}: container type differs`;
  const volatile = (key) => key === "modified" && location.endsWith(".timestamps");
  const expectedKeys = Object.keys(expected).filter((key) => !volatile(key));
  const actualKeys = Object.keys(actual).filter((key) => !volatile(key));
  if (JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys)) {
    return `${location}: keys expected ${expectedKeys.join(",")}, observed ${actualKeys.join(",")}`.slice(0, 1_000);
  }
  for (const key of expectedKeys) {
    const difference = firstDifference(expected[key], actual[key], `${location}.${key}`);
    if (difference) return difference;
  }
  return null;
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

async function bridgeRequest(method, endpoint, body) {
  const response = await fetch(`http://${discovery.host}:${discovery.port}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${discovery.token}`,
      "X-Request-Id": `qualify-v03-${++requestSequence}`,
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(25_000),
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

async function currentMap() {
  const value = await bridgeMust("GET", "/v1/maps");
  if (value.maps.length !== 1) throw new Error(`expected one isolated map, observed ${value.maps.length}`);
  return value.maps[0];
}

async function stableMap(samples = 3) {
  let last;
  let stable = 0;
  return waitFor(async () => {
    const map = await currentMap();
    stable = map.snapshot_sha256 === last ? stable + 1 : 1;
    last = map.snapshot_sha256;
    return stable >= samples ? map : null;
  }, 10_000, "stable map snapshot");
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

function capabilityScope(id) {
  if (id === "view.filter.literal") return "view";
  if (id.startsWith("node.") || id.startsWith("summary.") || id.startsWith("connector.")
      || id.startsWith("transaction.") || id.startsWith("history.")) return "edit";
  return "read";
}

function candidateManifest(source) {
  const manifest = structuredClone(source);
  manifest.generated_at = new Date().toISOString();
  manifest.addon_version = "0.3.0";
  for (const capabilityId of [...readCapabilities, ...writeCapabilities, ...organizeCapabilities]) {
    let capability = manifest.capabilities.find((item) => item.capability_id === capabilityId);
    if (!capability) {
      capability = {
        capability_id: capabilityId,
        scope: capabilityScope(capabilityId),
        status: "verified_internal_api",
        route: "internal_api",
        risk: capabilityId === "node.delete" || capabilityId === "connector.edit" ? "confirm" : "normal",
        freeplane_version: "1.13.3",
        qualification_report: qualificationId,
        evidence: [],
      };
      manifest.capabilities.push(capability);
    }
    capability.qualification_report = qualificationId;
    if (organizeCapabilities.includes(capabilityId)) {
      capability.status = capabilityId === "view.filter.literal" ? "verified_public_api" : "verified_internal_api";
      capability.route = capabilityId === "view.filter.literal" ? "public_api" : "internal_api";
      capability.risk = "normal";
      capability.evidence = ["v0.3.research_map_35_33", "v0.3.undo_redo", "v0.3.failure_rollback"];
    }
  }
  for (const [capabilityId, evidence] of [
    ["node.conditional_style", "Executable conditional-style expressions are intentionally unavailable"],
    ["node.reminder.script", "Reminder scripts are intentionally unavailable"],
  ]) {
    if (!manifest.capabilities.some((item) => item.capability_id === capabilityId)) {
      manifest.capabilities.push({
        capability_id: capabilityId,
        scope: "edit",
        status: "unsupported",
        route: "internal_api",
        risk: "blocked",
        freeplane_version: "1.13.3",
        qualification_report: qualificationId,
        evidence: [evidence],
      });
    }
  }
  return manifest;
}

async function startMcp(candidateRoot, runtimeDir) {
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "packages/server/dist/index.js")],
    cwd: candidateRoot,
    env: { ...getDefaultEnvironment(), FREEPLANE_MCP_RUNTIME_DIR: runtimeDir },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-65_536); });
  client = new Client(
    { name: "freeplane-mcp-v0.3-qualification", version: "0.3.0" },
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

function input(map, operations, summary) {
  return {
    map_id: map.map_id,
    expected_content_revision: map.content_revision,
    expected_view_revision: null,
    idempotency_key: randomUUID(),
    dry_run: false,
    operations,
    confirmation: null,
    user_summary: summary,
  };
}

function baseOperations(rootId) {
  const operations = [];
  for (let section = 0; section < 5; section++) {
    operations.push({
      op: "create_node",
      temp_id: `$s${section}`,
      parent_id: rootId,
      index: section,
      content: { text: sectionLabels[section] },
    });
    for (let item = 0; item < 5; item++) {
      operations.push({
        op: "create_node",
        temp_id: `$n${section}_${item}`,
        parent_id: `$s${section}`,
        index: item,
        content: { text: `Baseline evidence ${section + 1}.${item + 1}` },
      });
    }
  }
  const content = Array.from({ length: 25 }, (_, index) => `$n${Math.floor(index / 5)}_${index % 5}`);
  for (let index = 0; index < content.length - 1; index++) {
    operations.push({ op: "add_connector", source_id: content[index], target_id: content[index + 1], properties: {} });
  }
  for (let index = 0; index < 4; index++) {
    operations.push({ op: "add_connector", source_id: `$s${index}`, target_id: `$s${index + 1}`, properties: { width: 2 } });
  }
  for (let index = 0; index < 5; index++) {
    operations.push({
      op: "add_connector",
      source_id: `$n${index}_0`,
      target_id: `$n${(index + 2) % 5}_4`,
      properties: { shape: "CUBIC_CURVE", middle_label: `cross-${index + 1}` },
    });
  }
  return operations;
}

function organizeOperations(ids) {
  const targetTexts = [
    "365d HR 1.41",
    "730d HR 1.41",
    "730d AUC gain stable",
    "365d AUC unstable",
    "New validation branch",
  ];
  const operations = targetTexts.map((text, index) => ({
    op: "update_content",
    node_id: ids[`$n${index}_0`],
    text,
  }));
  const layouts = [
    "TOPTOBOTTOM_BOTHSIDES_CENTERED",
    "TOPTOBOTTOM_RIGHT_CENTERED",
    "LEFTTORIGHT_BOTHSIDES_CENTERED",
    "LEFTTORIGHT_BOTTOM_CENTERED",
    "AUTO",
  ];
  const shapes = ["RECTANGLE", "BUBBLE", "OVAL", "WIDE_HEXAGON", "NARROW_HEXAGON"];
  for (let index = 0; index < 5; index++) {
    operations.push(
      { op: "set_side", node_id: ids[`$s${index}`], side: index % 2 === 0 ? "RIGHT" : "LEFT" },
      { op: "set_style", node_id: ids[`$s${index}`], style: {
        background_color: colors[index], text_color: "#1F1F1F", bold: true,
        font_size: 18 + index, node_shape: shapes[index],
      } },
      { op: "set_layout", node_id: ids[`$s${index}`], layout: {
        child_nodes: layouts[index], horizontal_shift: index * 20, vertical_shift: index * 120,
        minimal_distance_between_children: 24 + index * 2, base_distance_to_children: 36 + index * 2,
      } },
    );
  }
  operations.push(
    { op: "set_free", node_id: ids.$n3_3, free: true },
    { op: "set_layout", node_id: ids.$n3_3, layout: { horizontal_shift: 80, vertical_shift: 45 } },
    { op: "set_cloud", node_id: ids.$s2, enabled: true, shape: "ROUND_RECT", color: "#BDD7EE" },
    { op: "set_bookmark", node_id: ids.$s3, bookmark: { action: "set", name: "validation-evidence", type: "SELECT" } },
    { op: "set_formula", node_id: ids.$n1_4, expression: "=(365 + 365) / 2" },
    { op: "set_reminder", node_id: ids.$n4_3, reminder: {
      action: "set", at: "2030-01-01T00:00:00.000Z", period_unit: "YEAR", period: 1,
    } },
    { op: "clone_node", temp_id: "$clone", source_id: ids.$n3_4, parent_id: ids.$s4, index: 5, with_subtree: false },
    { op: "create_summary", temp_id: "$summary", parent_id: ids.$s4,
      first_child_id: ids.$n4_0, last_child_id: ids.$n4_1, text: "Validation evidence summary" },
  );
  return operations;
}

function flatten(node, result = []) {
  result.push(node);
  for (const childNode of node.children ?? []) flatten(childNode, result);
  return result;
}

function overlapRatio(left, right) {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  const smaller = Math.min(left.width * left.height, right.width * right.height);
  return smaller === 0 ? 0 : (width * height) / smaller;
}

try {
  process.stderr.write("v0.3: building candidate and starting isolated Freeplane\n");
  await execFile("npm", ["run", "build"], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  await execFile(process.execPath, [path.join(root, "scripts/build_addon.mjs")], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  addCheck("build.candidate", true, "TypeScript build, Java 17 compile, JAR packaging, and BridgeSelfTest passed");

  const priorReportBytes = await readFile(priorReportPath);
  const priorReport = JSON.parse(priorReportBytes);
  inheritedReport = { stage: priorReport.stage, qualification_report: priorReport.qualification_report, sha256: sha256(priorReportBytes) };
  addCheck(
    "preservation.v0.2_gate_inherited",
    priorReport.passed === true && Object.values(priorReport.hard_gate ?? {}).every(Boolean),
    `v0.2 qualified report ${inheritedReport.sha256} remains the core edit evidence base`,
  );

  qualificationRoot = await mkdtemp(path.join(tmpdir(), "freeplane-mcp-v0.3-"));
  const userRoot = path.join(qualificationRoot, "user");
  const profile = path.join(userRoot, "1.12.x");
  const runtimeDir = path.join(qualificationRoot, "runtime");
  const workDir = path.join(qualificationRoot, "work");
  const fixture = path.join(workDir, "qualification.mm");
  const candidateRoot = path.join(qualificationRoot, "candidate");
  await mkdir(path.join(profile, "lib"), { recursive: true });
  await mkdir(path.join(profile, "scripts/init"), { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  await chmod(runtimeDir, 0o700);
  await mkdir(workDir, { recursive: true });
  await mkdir(path.join(candidateRoot, "qualification/reports"), { recursive: true });
  await mkdir(path.join(candidateRoot, "qualification/capabilities"), { recursive: true });
  await copyFile(addonJar, path.join(profile, "lib", path.basename(addonJar)));
  await copyFile(fixtureSource, fixture);
  const fixtureHash = sha256(await readFile(fixture));
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
      && discovery.addon_version === "0.3.0"
      && discovery.freeplane_build_fingerprint === fingerprint
      && (await stat(runtimeDir)).mode % 0o1000 === 0o700
      && (await stat(path.join(runtimeDir, "bridge.json"))).mode % 0o1000 === 0o600,
    "isolated 0.3.0 bridge uses dynamic loopback binding and private discovery",
  );
  const initialMap = await waitFor(async () => {
    const value = await bridgeMust("GET", "/v1/maps");
    return value.maps.length === 1 ? value.maps[0] : null;
  }, 20_000, "isolated map");
  const mapId = initialMap.map_id;
  const initialRead = await bridgeMust("POST", "/v1/read", { map_id: mapId });
  const rootId = initialRead.content.root.id;

  await startMcp(candidateRoot, runtimeDir);
  const listedTools = (await client.listTools()).tools.map((tool) => tool.name).sort();
  addCheck("mcp.nine_tool_surface", JSON.stringify(listedTools) === JSON.stringify(expectedTools), "exact v0.3 nine-tool surface registered");
  const status = await mcpMust("freeplane_status", {});
  addCheck(
    "mcp.qualification_identity",
    status.data.qualification_report === qualificationId
      && status.data.qualification_passed === true
      && status.data.bridge.addon_version === "0.3.0",
    "candidate manifest, server, bridge, and protocol identity agree",
  );

  const base = await mcpMust("freeplane_apply", input(await currentMap(), baseOperations(rootId), "Build synthetic five-section research map"));
  const baseMap = await stableMap();
  const baseRead = await bridgeMust("POST", "/v1/read", { map_id: mapId });
  addCheck(
    "fixture.base_31_nodes_33_relations",
    baseMap.node_count === 31
      && flatten(baseRead.content.root).reduce((sum, node) => sum + (node.connectors?.length ?? 0), 0) === 33,
    "synthetic baseline contains root + 30 nodes and exactly 33 native connectors",
  );

  const { compileOperations } = await import(path.join(root, "packages/server/dist/writeSafety.js"));
  const organize = organizeOperations(base.data.temporary_node_ids);
  const compiled = compileOperations(organize);
  process.stderr.write(`v0.3: injecting rollback failures across ${compiled.length} organization operations\n`);
  const rollbackStarted = performance.now();
  for (let index = 1; index <= compiled.length; index++) {
    const before = await currentMap();
    const plan = await bridgeMust("POST", "/v1/transactions/plan", {
      map_id: mapId,
      expected_content_revision: before.content_revision,
      expected_view_revision: null,
      operations: compiled,
    });
    const failed = await bridgeRequest("POST", "/v1/transactions/commit", {
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      failure_after_op: index,
    });
    const after = await stableMap(2);
    if (failed.payload.error?.category !== "POSTCONDITION_FAILED"
        || !String(failed.payload.error?.message ?? "").startsWith("Injected failure after operation")
        || failed.payload.error?.details?.snapshot_equal !== true
        || after.snapshot_sha256 !== before.snapshot_sha256) {
      throw new Error(`rollback ${index}/${compiled.length} diverged: ${failed.payload.error?.category}: ${failed.payload.error?.message ?? ""} before=${before.snapshot_sha256} after=${after.snapshot_sha256} details=${JSON.stringify(failed.payload.error?.details ?? {})}`);
    }
  }
  metrics.rollback_matrix_ms = Math.round((performance.now() - rollbackStarted) * 100) / 100;
  addCheck("transaction.organization_failure_points", true, `${compiled.length}/${compiled.length} failure points restored canonical equality`);

  const organized = await mcpMust("freeplane_apply", input(await currentMap(), organize, "Qualify v0.3 research-map organization"));
  const organizedMap = await stableMap();
  const organizedRead = await bridgeMust("POST", "/v1/read", { map_id: mapId });
  const nodes = flatten(organizedRead.content.root);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ids = base.data.temporary_node_ids;
  const expectedTexts = ["365d HR 1.41", "730d HR 1.41", "730d AUC gain stable", "365d AUC unstable", "New validation branch"];
  addCheck(
    "research.h2_exact_updates",
    expectedTexts.every((text, index) => byId.get(ids[`$n${index}_0`])?.text === text),
    "all four H2 findings and the validation branch match the frozen expected text",
  );
  addCheck(
    "research.35_nodes_33_relations",
    organizedMap.node_count === 35
      && nodes.reduce((sum, node) => sum + (node.connectors?.length ?? 0), 0) === 33,
    "organized map contains exactly 35 nodes and 33 relationships",
  );
  addCheck(
    "organization.five_group_styles",
    colors.every((color, index) => byId.get(ids[`$s${index}`])?.style?.background_color?.toLowerCase() === color.toLowerCase())
      && new Set(colors).size === 5,
    "five research sections have five distinct native background styles",
  );
  const summaryNodes = nodes.filter((node) => node.summary?.summary_node);
  const firstGroupNodes = nodes.filter((node) => node.summary?.first_group_node);
  const clone = byId.get(organized.data.temporary_node_ids.$clone);
  addCheck(
    "organization.native_summary_clone",
    summaryNodes.length === 1
      && summaryNodes[0].summary.always_unfolded === true
      && firstGroupNodes.length === 1
      && clone?.clones?.content_peer_count === 1,
    "native summary group/first-group hooks and a two-member content clone read back correctly",
  );
  addCheck(
    "organization.safe_special_fields",
    byId.get(ids.$s2)?.cloud?.enabled === true
      && byId.get(ids.$s3)?.bookmark?.name === "validation-evidence"
      && byId.get(ids.$n1_4)?.formula?.expression === "=(365 + 365) / 2"
      && byId.get(ids.$n4_3)?.reminder?.script_present === false,
    "cloud, bookmark, arithmetic-only formula, and script-free reminder are stable in readback",
  );

  const layout = await waitFor(async () => {
    const value = await bridgeMust("POST", "/v1/qualification/layout", {
      map_id: mapId,
      node_ids: Array.from({ length: 5 }, (_, index) => ids[`$s${index}`]),
    });
    return value.bounds.every((bound) => bound.width > 0 && bound.height > 0) ? value.bounds : null;
  }, 10_000, "five-section Swing layout");
  let worstOverlap = 0;
  for (let left = 0; left < layout.length; left++) {
    for (let right = left + 1; right < layout.length; right++) {
      worstOverlap = Math.max(worstOverlap, overlapRatio(layout[left], layout[right]));
    }
  }
  metrics.section_overlap_max_ratio = Math.round(worstOverlap * 10_000) / 10_000;
  addCheck("layout.no_severe_overlap", worstOverlap <= 0.2, `worst section-heading overlap ratio ${metrics.section_overlap_max_ratio}`);

  const beforeFilter = await currentMap();
  const filtered = await mcpMust("freeplane_view", {
    action: "apply_filter",
    map_id: mapId,
    expected_view_revision: beforeFilter.view_revision,
    query: { mode: "literal", value: "validation", case_sensitive: false },
    show_ancestors: true,
    show_descendants: false,
  });
  addCheck(
    "view.literal_filter",
    filtered.data.filter_active === true
      && filtered.data.visible_node_count > 0
      && filtered.data.visible_node_count < filtered.data.total_node_count
      && filtered.after.content_revision === beforeFilter.content_revision,
    "literal filter changed only view revision and hid non-matching branches",
  );
  const cleared = await mcpMust("freeplane_view", {
    action: "clear_filter",
    map_id: mapId,
    expected_view_revision: filtered.after.view_revision,
  });
  addCheck(
    "view.filter_clear",
    cleared.data.filter_active === false
      && cleared.data.visible_node_count > filtered.data.visible_node_count
      && cleared.data.visible_node_count <= cleared.data.total_node_count
      && cleared.after.content_revision === beforeFilter.content_revision,
    "filter clear restored native unfiltered visibility without changing content revision",
  );

  const undo = await mcpMust("freeplane_history", {
    map_id: mapId,
    action: "undo",
    steps: 1,
    expected_content_revision: (await currentMap()).content_revision,
    idempotency_key: randomUUID(),
  });
  addCheck("history.one_undo_exact", undo.data.snapshot_after_sha256 === baseMap.snapshot_sha256, "one undo restored the exact 31-node baseline");
  const redo = await mcpMust("freeplane_history", {
    map_id: mapId,
    action: "redo",
    steps: 1,
    expected_content_revision: (await currentMap()).content_revision,
    idempotency_key: randomUUID(),
  });
  const redoRead = await bridgeMust("POST", "/v1/read", { map_id: mapId });
  const redoDifference = firstDifference(organizedRead.content, redoRead.content);
  addCheck(
    "history.one_redo_exact",
    redo.data.snapshot_after_sha256 === organizedMap.snapshot_sha256 && redoDifference === null,
    redoDifference ?? "one redo restored the exact organized snapshot",
  );

  addCheck(
    "policy.executable_payloads_unavailable",
    candidate.capabilities.find((item) => item.capability_id === "node.conditional_style")?.status === "unsupported"
      && candidate.capabilities.find((item) => item.capability_id === "node.reminder.script")?.status === "unsupported",
    "conditional scripts, CSS payloads, and reminder scripts remain outside the MCP surface",
  );
  addCheck(
    "isolation.fixture_unchanged",
    sha256(await readFile(fixture)) === fixtureHash && sha256(await readFile(fixtureSource)) === fixtureHash,
    "qualification edits remained unsaved and source/working fixture bytes were unchanged",
  );
  addCheck(
    "mcp.stderr_private",
    !stderr.includes(discovery.token) && !stderr.includes("365d HR 1.41"),
    "MCP and Freeplane stderr contain no token or research-map text",
  );
} catch (error) {
  fatalError = error;
  checks.push({ id: "qualification.fatal", status: "fail", evidence: sanitize(error.message) });
} finally {
  try {
    await stopIsolatedProcess();
  } catch (error) {
    fatalError ??= error;
    checks.push({ id: "isolation.cleanup", status: "fail", evidence: sanitize(error.message) });
  }
}

const passed = !fatalError && checks.length > 0 && checks.every((check) => check.status === "pass");
const report = {
  schema_version: 1,
  stage: "v0.3",
  generated_at: new Date().toISOString(),
  passed,
  qualification_report: qualificationId,
  freeplane: { version: "1.13.3", build_fingerprint: fingerprint },
  addon_version: "0.3.0",
  server_version: "0.3.0",
  inherited_qualification_reports: inheritedReport ? [inheritedReport] : [],
  checks,
  metrics,
  hard_gate: {
    exact_tool_surface: checks.some((check) => check.id === "mcp.nine_tool_surface" && check.status === "pass"),
    research_map_35_33: checks.some((check) => check.id === "research.35_nodes_33_relations" && check.status === "pass"),
    h2_exact_updates: checks.some((check) => check.id === "research.h2_exact_updates" && check.status === "pass"),
    five_groups_distinct: checks.some((check) => check.id === "organization.five_group_styles" && check.status === "pass"),
    native_summary_clone: checks.some((check) => check.id === "organization.native_summary_clone" && check.status === "pass"),
    literal_filter_only: checks.some((check) => check.id === "view.literal_filter" && check.status === "pass"),
    no_severe_overlap: metrics.section_overlap_max_ratio <= 0.2,
    one_undo_redo_exact: checks.some((check) => check.id === "history.one_redo_exact" && check.status === "pass"),
    failure_zero_partial_writes: checks.some((check) => check.id === "transaction.organization_failure_points" && check.status === "pass"),
    executable_payloads_unavailable: checks.some((check) => check.id === "policy.executable_payloads_unavailable" && check.status === "pass"),
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
