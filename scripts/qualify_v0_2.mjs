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
  ?? path.join(homedir(), "Library/Caches/Freeplane-MCP/build/v0.2");
const addonJar = path.join(buildDir, "freeplane-mcp-bridge-0.2.0.jar");
const fixtureSource = path.join(root, "fixtures/core-mm/v0.0b.mm");
const reportPath = path.join(root, "qualification/reports/v0.2-local.json");
const priorReportPath = path.join(root, "qualification/reports/v0.1-local.json");
const manifestPath = path.join(root, "qualification/capabilities/capabilities.json");
const fingerprint = "ff6dab76e60acfb0666ee8ac90dcf2df5bbb1975c2d99eab59ca3f08dcda1822";
const qualificationId = `v0.2-${fingerprint.slice(0, 12)}`;
const readCapabilities = [
  "runtime.status", "runtime.capabilities", "map.read", "node.read", "map.changes",
  "map.list", "map.selection", "map.search.literal", "map.file_read",
];
const writeCapabilities = [
  "node.create", "node.update_text", "node.update_details_note", "node.attributes",
  "node.tags", "node.icons", "node.link", "node.move_reorder", "node.fold",
  "node.delete", "connector.edit", "transaction.atomic_compound_undo", "history.undo_redo",
];
const expectedTools = [
  "freeplane_apply", "freeplane_capabilities", "freeplane_changes", "freeplane_history",
  "freeplane_list_maps", "freeplane_read", "freeplane_search", "freeplane_status",
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
      "X-Request-Id": `qualify-v02-${++requestSequence}`,
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(25_000),
  });
  const payload = JSON.parse(await response.text());
  return { status: response.status, payload };
}

async function bridgeMust(method, endpoint, body) {
  const response = await bridgeRequest(method, endpoint, body);
  if (response.status !== 200 || response.payload.ok !== true) {
    throw new Error(`${endpoint} failed: ${response.payload.error?.category ?? response.status}`);
  }
  return response.payload.data;
}

async function currentMap() {
  const value = await bridgeMust("GET", "/v1/maps");
  if (value.maps.length !== 1) throw new Error(`expected one isolated map, observed ${value.maps.length}`);
  return value.maps[0];
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
    throw new Error(`${name} failed: ${result.error?.category ?? "unknown"}: ${result.error?.message ?? "no message"} ${JSON.stringify(result.error?.details ?? {})}`);
  }
  return result;
}

function candidateManifest(source) {
  const manifest = structuredClone(source);
  manifest.generated_at = new Date().toISOString();
  manifest.addon_version = "0.2.0";
  const ids = [...readCapabilities, ...writeCapabilities];
  for (const capabilityId of ids) {
    let capability = manifest.capabilities.find((item) => item.capability_id === capabilityId);
    if (!capability) {
      capability = {
        capability_id: capabilityId,
        scope: capabilityId === "history.undo_redo" || capabilityId.startsWith("node.")
          || capabilityId.startsWith("connector.") || capabilityId.startsWith("transaction.") ? "edit" : "read",
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
    if (writeCapabilities.includes(capabilityId)) {
      capability.status = "verified_internal_api";
      capability.route = "internal_api";
      capability.risk = capabilityId === "node.delete" || capabilityId === "connector.edit" ? "confirm" : "normal";
      capability.evidence = ["v0.2.atomic_readback", "v0.2.undo_redo", "v0.2.failure_rollback"];
    }
  }
  return manifest;
}

async function startMcp(candidateRoot, runtimeDir) {
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "packages/server/dist/index.js")],
    cwd: candidateRoot,
    env: {
      ...getDefaultEnvironment(),
      FREEPLANE_MCP_RUNTIME_DIR: runtimeDir,
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-65_536); });
  client = new Client(
    { name: "freeplane-mcp-v0.2-qualification", version: "0.2.0" },
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

function coreOperations(rootId) {
  return [
    { op: "create_node", temp_id: "$a", parent_id: rootId, index: 0, content: { text: "A", details: "A details", note: "A note" } },
    { op: "create_node", temp_id: "$b", parent_id: rootId, index: 1, content: { text: "B" } },
    { op: "create_node", temp_id: "$c", parent_id: rootId, index: 2, content: { text: "C" } },
    { op: "update_content", node_id: "$a", text: "A updated", details: "A details updated", note: "A note updated" },
    { op: "set_attributes", node_id: "$a", attributes: [{ name: "key", value: "one" }, { name: "key", value: "two" }] },
    { op: "set_tags", node_id: "$a", tags: ["alpha", "beta"] },
    { op: "set_icons", node_id: "$a", icons: ["button_ok"] },
    { op: "set_link", node_id: "$b", link: { kind: "uri", uri: "https://example.com/qualified" } },
    { op: "move_node", node_id: "$c", parent_id: "$a", index: 0 },
    { op: "reorder_children", parent_id: rootId, child_ids: ["$b", "$a"] },
    { op: "set_folded", node_id: "$a", folded: true },
    {
      op: "add_connector",
      source_id: "$b",
      target_id: "$c",
      properties: { shape: "LINE", color: "#336699", width: 2, middle_label: "qualified" },
    },
  ];
}

function input(map, operations, key = randomUUID(), summary = "v0.2 qualification") {
  return {
    map_id: map.map_id,
    expected_content_revision: map.content_revision,
    expected_view_revision: null,
    idempotency_key: key,
    dry_run: false,
    operations,
    confirmation: null,
    user_summary: summary,
  };
}

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
}

try {
  process.stderr.write("v0.2: building candidate and starting isolated Freeplane\n");
  await execFile("npm", ["run", "build"], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  await execFile(process.execPath, [path.join(root, "scripts/build_addon.mjs")], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  addCheck("build.candidate", true, "TypeScript build, Java 17 compile, JAR packaging, and BridgeSelfTest passed");
  const priorReportBytes = await readFile(priorReportPath);
  const priorReport = JSON.parse(priorReportBytes);
  inheritedReport = {
    stage: priorReport.stage,
    qualification_report: priorReport.qualification_report,
    sha256: sha256(priorReportBytes),
  };
  addCheck(
    "preservation.v0.1_gate_inherited",
    priorReport.passed === true && Object.values(priorReport.hard_gate ?? {}).every(Boolean),
    `v0.1 qualified report ${inheritedReport.sha256} remains the read-capability evidence base`,
  );

  qualificationRoot = await mkdtemp(path.join(tmpdir(), "freeplane-mcp-v0.2-"));
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
  const candidate = candidateManifest(sourceManifest);
  await writeFile(
    path.join(candidateRoot, "qualification/reports/v0.0a-local.json"),
    await readFile(path.join(root, "qualification/reports/v0.0a-local.json"), "utf8"),
  );
  await writeFile(
    path.join(candidateRoot, "qualification/capabilities/capabilities.json"),
    `${JSON.stringify(candidate, null, 2)}\n`,
  );

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
  }, 30_000, "bridge discovery");
  addCheck(
    "isolation.bridge_identity",
    discovery.host === "127.0.0.1"
      && discovery.addon_version === "0.2.0"
      && discovery.freeplane_build_fingerprint === fingerprint
      && (await stat(runtimeDir)).mode % 0o1000 === 0o700
      && (await stat(path.join(runtimeDir, "bridge.json"))).mode % 0o1000 === 0o600,
    "isolated 0.2.0 bridge uses dynamic loopback binding and private discovery",
  );
  const maps = await waitFor(async () => {
    const value = await bridgeMust("GET", "/v1/maps");
    return value.maps.length === 1 ? value.maps : null;
  }, 20_000, "isolated map");
  const mapId = maps[0].map_id;
  const initial = await bridgeMust("POST", "/v1/read", { map_id: mapId });
  const rootId = initial.content.root.id;
  let baselineHash = maps[0].snapshot_sha256;

  await startMcp(candidateRoot, runtimeDir);
  const listedTools = (await client.listTools()).tools.map((tool) => tool.name).sort();
  addCheck("mcp.eight_tool_surface", JSON.stringify(listedTools) === JSON.stringify(expectedTools), "exact six read plus apply/history tools registered");
  const status = await mcpMust("freeplane_status", {});
  addCheck(
    "mcp.qualification_identity",
    status.data.qualification_report === qualificationId
      && status.data.qualification_passed === true
      && status.data.bridge.addon_version === "0.2.0",
    "candidate manifest, server, bridge, and protocol identity agree",
  );
  baselineHash = (await currentMap()).snapshot_sha256;

  const { compileOperations } = await import(path.join(root, "packages/server/dist/writeSafety.js"));
  const core = coreOperations(rootId);
  const compiledCore = compileOperations(core);
  process.stderr.write(`v0.2: injecting rollback failures across ${compiledCore.length} core operations\n`);
  for (let index = 1; index <= compiledCore.length; index++) {
    const map = await currentMap();
    const plan = await bridgeMust("POST", "/v1/transactions/plan", {
      map_id: mapId,
      expected_content_revision: map.content_revision,
      expected_view_revision: null,
      operations: compiledCore,
    });
    const failed = await bridgeRequest("POST", "/v1/transactions/commit", {
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      failure_after_op: index,
    });
    const after = await currentMap();
    if (failed.payload.error?.details?.snapshot_equal !== true || after.snapshot_sha256 !== map.snapshot_sha256) {
      throw new Error(`core rollback ${index} left partial state: ${failed.payload.error?.category} before=${map.snapshot_sha256} after=${after.snapshot_sha256} details=${JSON.stringify(failed.payload.error?.details ?? {})}`);
    }
  }
  addCheck("transaction.new_operation_failure_points", true, `${compiledCore.length}/${compiledCore.length} new core failure points restored canonical equality`);

  const beforeCore = await currentMap();
  const coreInput = input(beforeCore, core);
  const dryRunBefore = (await currentMap()).snapshot_sha256;
  const dryRun = await mcpMust("freeplane_apply", { ...coreInput, dry_run: true });
  const dryRunAfter = (await currentMap()).snapshot_sha256;
  addCheck(
    "apply.dry_run_zero_effect",
    dryRun.effect_status === "planned"
      && dryRun.data.plan_hash.length === 64
      && dryRunBefore === dryRunAfter,
    "dry-run returned normalized plan/hash and changed no canonical state",
  );

  const committed = await mcpMust("freeplane_apply", coreInput);
  const afterCore = await currentMap();
  const afterCoreRead = await bridgeMust("POST", "/v1/read", { map_id: mapId });
  const temp = committed.data.temporary_node_ids;
  addCheck(
    "apply.core_commit_readback",
    committed.effect_status === "verified"
      && committed.data.operation_count === core.length
      && Object.keys(temp).length === 3
      && committed.data.snapshot_after_sha256 === afterCore.snapshot_sha256,
    "all core edits committed atomically with canonical readback and temporary ID resolution",
  );
  const replay = await mcpMust("freeplane_apply", coreInput);
  addCheck(
    "idempotency.same_payload_replay",
    replay.data.transaction_id === committed.data.transaction_id
      && (await currentMap()).content_revision === afterCore.content_revision,
    "same key and payload returned the stored receipt without another write",
  );
  const reused = await mcpCall("freeplane_apply", { ...coreInput, user_summary: "different payload" });
  addCheck("idempotency.different_payload_rejected", reused.error?.category === "IDEMPOTENCY_KEY_REUSED", "same key with another payload was rejected");

  const stale = await mcpCall("freeplane_apply", input({ ...afterCore, content_revision: beforeCore.content_revision }, [
    { op: "update_content", node_id: temp.$a, text: "stale" },
  ]));
  addCheck(
    "revision.conflict_zero_write",
    stale.error?.category === "REVISION_CONFLICT" && (await currentMap()).snapshot_sha256 === afterCore.snapshot_sha256,
    "stale content revision was rejected before mutation",
  );

  const undoCore = await mcpMust("freeplane_history", {
    map_id: mapId,
    action: "undo",
    steps: 1,
    expected_content_revision: (await currentMap()).content_revision,
    idempotency_key: randomUUID(),
  });
  addCheck("history.one_undo_exact", undoCore.data.snapshot_after_sha256 === baselineHash, "one undo restored the exact pre-apply snapshot");
  const redoCore = await mcpMust("freeplane_history", {
    map_id: mapId,
    action: "redo",
    steps: 1,
    expected_content_revision: (await currentMap()).content_revision,
    idempotency_key: randomUUID(),
  });
  const redoRead = await bridgeMust("POST", "/v1/read", { map_id: mapId });
  const redoDifference = firstDifference(afterCoreRead.content, redoRead.content);
  addCheck(
    "history.one_redo_exact",
    redoCore.data.snapshot_after_sha256 === afterCore.snapshot_sha256 && redoDifference === null,
    redoDifference ?? "one redo restored the exact committed snapshot",
  );

  const readAfterCore = await mcpMust("freeplane_read", { map_id: mapId, scope: "map", depth: 10, max_nodes: 100 });
  const source = readAfterCore.data.nodes.find((node) => node.node_id === temp.$b);
  const connectorId = source?.connectors?.[0]?.connector_id;
  addCheck("connector.session_handle", /^fpconn:[a-f0-9]{64}$/.test(connectorId ?? ""), "connector readback returned a fingerprint-scoped handle");

  const updateOperations = [{
    op: "update_connector",
    connector_id: connectorId,
    properties: { shape: "CUBIC_CURVE", width: 3, middle_label: "updated" },
  }];
  const updateCompiled = compileOperations(updateOperations);
  for (let index = 1; index <= updateCompiled.length; index++) {
    const map = await currentMap();
    const plan = await bridgeMust("POST", "/v1/transactions/plan", {
      map_id: mapId, expected_content_revision: map.content_revision, operations: updateCompiled,
    });
    const failed = await bridgeRequest("POST", "/v1/transactions/commit", {
      plan_id: plan.plan_id, plan_hash: plan.plan_hash, failure_after_op: index,
    });
    if (failed.payload.error?.details?.snapshot_equal !== true || (await currentMap()).snapshot_sha256 !== afterCore.snapshot_sha256) {
      throw new Error("connector update rollback diverged");
    }
  }
  const updateResult = await mcpMust("freeplane_apply", input(await currentMap(), updateOperations));
  addCheck("connector.update_verified", updateResult.effect_status === "verified", "connector update committed with canonical readback");
  const undoUpdate = await mcpMust("freeplane_history", {
    map_id: mapId, action: "undo", steps: 1,
    expected_content_revision: (await currentMap()).content_revision, idempotency_key: randomUUID(),
  });
  addCheck(
    "connector.update_one_undo_exact",
    undoUpdate.data.snapshot_after_sha256 === afterCore.snapshot_sha256,
    "one undo restored the exact pre-connector-update snapshot",
  );

  const destructiveOperations = [
    { op: "remove_connector", connector_ids: [connectorId] },
    { op: "delete_nodes", node_ids: [temp.$c] },
  ];
  const destructiveCompiled = compileOperations(destructiveOperations);
  for (let index = 1; index <= destructiveCompiled.length; index++) {
    const map = await currentMap();
    const beforeRead = await bridgeMust("POST", "/v1/read", { map_id: mapId });
    const plan = await bridgeMust("POST", "/v1/transactions/plan", {
      map_id: mapId, expected_content_revision: map.content_revision, operations: destructiveCompiled,
    });
    const failed = await bridgeRequest("POST", "/v1/transactions/commit", {
      plan_id: plan.plan_id, plan_hash: plan.plan_hash, failure_after_op: index,
    });
    const after = await currentMap();
    if (failed.payload.error?.details?.snapshot_equal !== true || after.snapshot_sha256 !== map.snapshot_sha256) {
      const afterRead = await bridgeMust("POST", "/v1/read", { map_id: mapId });
      throw new Error(`destructive rollback ${index} diverged: ${firstDifference(beforeRead.content, afterRead.content)} ${failed.payload.error?.category} before=${map.snapshot_sha256} after=${after.snapshot_sha256} details=${JSON.stringify(failed.payload.error?.details ?? {})}`);
    }
  }
  const destructiveInput = input(await currentMap(), destructiveOperations);
  const challenge = await mcpCall("freeplane_apply", destructiveInput);
  addCheck(
    "confirmation.bound_challenge",
    challenge.error?.category === "CONFIRMATION_REQUIRED"
      && challenge.error.details.plan_hash.length === 64
      && challenge.error.details.bound_revision === destructiveInput.expected_content_revision,
    "destructive plan returned a one-time revision- and hash-bound challenge",
  );
  let booleanBypassRejected = false;
  try {
    const invalid = await mcpCall("freeplane_apply", { ...destructiveInput, confirmation: true });
    booleanBypassRejected = invalid.ok === false;
  } catch {
    booleanBypassRejected = true;
  }
  addCheck("confirmation.boolean_bypass_rejected", booleanBypassRejected, "ordinary boolean confirmation did not reach the write handler");
  const deleted = await mcpMust("freeplane_apply", {
    ...destructiveInput,
    confirmation: { confirmation_id: challenge.error.details.confirmation_id, accepted: true },
  });
  addCheck("confirmation.delete_verified", deleted.effect_status === "verified", "confirmed connector/node deletion committed as one verified unit");
  const reuseConfirmation = await mcpCall("freeplane_apply", {
    ...destructiveInput,
    idempotency_key: randomUUID(),
    confirmation: { confirmation_id: challenge.error.details.confirmation_id, accepted: true },
  });
  addCheck("confirmation.one_time", reuseConfirmation.error?.category === "CONFIRMATION_EXPIRED", "confirmation token could not be used twice");
  const undoDelete = await mcpMust("freeplane_history", {
    map_id: mapId, action: "undo", steps: 1,
    expected_content_revision: (await currentMap()).content_revision, idempotency_key: randomUUID(),
  });
  addCheck("delete.one_undo_exact", undoDelete.data.snapshot_after_sha256 === afterCore.snapshot_sha256, "one undo restored deleted node and connector exactly");

  const finalUndoCore = await mcpMust("freeplane_history", {
    map_id: mapId, action: "undo", steps: 1,
    expected_content_revision: (await currentMap()).content_revision, idempotency_key: randomUUID(),
  });
  const cleanupRead = await bridgeMust("POST", "/v1/read", { map_id: mapId });
  const cleanupDifference = firstDifference(initial.content, cleanupRead.content);
  addCheck(
    "transaction.cleanup_exact",
    finalUndoCore.data.snapshot_after_sha256 === baselineHash && cleanupDifference === null,
    cleanupDifference ?? "qualification map returned to its initial canonical snapshot",
  );

  let multiStepRejected = false;
  try {
    const invalid = await mcpCall("freeplane_history", {
      map_id: mapId, action: "undo", steps: 2,
      expected_content_revision: (await currentMap()).content_revision, idempotency_key: randomUUID(),
    });
    multiStepRejected = invalid.ok === false;
  } catch {
    multiStepRejected = true;
  }
  addCheck("history.steps_pinned", multiStepRejected, "history steps other than one were rejected by schema");

  process.stderr.write("v0.2: measuring ten 100-operation commits\n");
  const latencies = [];
  for (let run = 0; run < 10; run++) {
    const operations = [];
    for (let index = 0; index < 50; index++) {
      operations.push({ op: "create_node", temp_id: `$p${index}`, parent_id: rootId, index, content: { text: `perf-${run}-${index}` } });
    }
    for (let index = 0; index < 50; index++) {
      operations.push({ op: "update_content", node_id: `$p${index}`, text: `perf-updated-${run}-${index}` });
    }
    const map = await currentMap();
    const started = performance.now();
    const result = await mcpMust("freeplane_apply", input(map, operations));
    latencies.push(performance.now() - started);
    if (result.effect_status !== "verified") throw new Error(`performance run ${run} was not verified`);
    const undone = await mcpMust("freeplane_history", {
      map_id: mapId, action: "undo", steps: 1,
      expected_content_revision: (await currentMap()).content_revision, idempotency_key: randomUUID(),
    });
    if (undone.data.snapshot_after_sha256 !== baselineHash) throw new Error(`performance run ${run} undo diverged`);
  }
  metrics.commit_100_ms = {
    p50: Math.round(percentile(latencies, 0.5) * 100) / 100,
    p95: Math.round(percentile(latencies, 0.95) * 100) / 100,
    max: Math.round(Math.max(...latencies) * 100) / 100,
    runs: latencies.length,
  };
  addCheck(
    "performance.100_ops_p95",
    metrics.commit_100_ms.p95 < 2_000,
    `100-operation commit p95 ${metrics.commit_100_ms.p95} ms across ${latencies.length} runs`,
  );

  const ledgerPath = path.join(runtimeDir, "write-state.json");
  const ledgerText = await readFile(ledgerPath, "utf8");
  addCheck(
    "idempotency.private_redacted_state",
    (await stat(ledgerPath)).mode % 0o1000 === 0o600
      && !ledgerText.includes("A details")
      && !ledgerText.includes("A note")
      && !ledgerText.includes("perf-updated"),
    "atomic idempotency state is 0600 and contains no node text, notes, or full request payloads",
  );
  addCheck(
    "isolation.fixture_unchanged",
    sha256(await readFile(fixture)) === fixtureHash && sha256(await readFile(fixtureSource)) === fixtureHash,
    "all qualification edits remained unsaved and source/working fixture bytes were unchanged",
  );
  addCheck("mcp.stderr_private", !stderr.includes(discovery.token) && !stderr.includes("A note"), "MCP and Freeplane stderr contain no token or node content");
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
  stage: "v0.2",
  generated_at: new Date().toISOString(),
  passed,
  qualification_report: qualificationId,
  freeplane: { version: "1.13.3", build_fingerprint: fingerprint },
  addon_version: "0.2.0",
  server_version: "0.2.0",
  inherited_qualification_reports: inheritedReport ? [inheritedReport] : [],
  checks,
  metrics,
  hard_gate: {
    exact_tool_surface: checks.some((check) => check.id === "mcp.eight_tool_surface" && check.status === "pass"),
    dry_run_zero_effect: checks.some((check) => check.id === "apply.dry_run_zero_effect" && check.status === "pass"),
    every_success_readback_verified: checks.some((check) => check.id === "apply.core_commit_readback" && check.status === "pass"),
    one_undo_redo_exact: checks.some((check) => check.id === "history.one_redo_exact" && check.status === "pass"),
    failure_zero_partial_writes: checks.some((check) => check.id === "transaction.new_operation_failure_points" && check.status === "pass"),
    revision_conflict_zero_write: checks.some((check) => check.id === "revision.conflict_zero_write" && check.status === "pass"),
    confirmation_bound: checks.some((check) => check.id === "confirmation.bound_challenge" && check.status === "pass"),
    idempotency_verified: checks.some((check) => check.id === "idempotency.same_payload_replay" && check.status === "pass"),
    performance_p95_under_2s: metrics.commit_100_ms?.p95 < 2_000,
  },
};
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

if (passed && Object.values(report.hard_gate).every(Boolean)) {
  const sourceManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, `${JSON.stringify(candidateManifest(sourceManifest), null, 2)}\n`);
}

if (qualificationRoot) await rm(qualificationRoot, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({ passed, report: path.relative(root, reportPath), checks: checks.length, metrics })}\n`);
if (!passed || !Object.values(report.hard_gate).every(Boolean)) process.exitCode = 1;
