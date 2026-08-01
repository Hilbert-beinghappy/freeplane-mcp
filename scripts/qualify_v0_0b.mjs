import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = process.cwd();
const app = process.env.FREEPLANE_APP ?? "/Applications/Freeplane.app";
const binary = path.join(app, "Contents/MacOS/Freeplane");
const buildDir = process.env.FREEPLANE_MCP_BUILD_DIR
  ?? path.join(homedir(), "Library/Caches/Freeplane-MCP/build/v0.1");
const addonJar = path.join(buildDir, "freeplane-mcp-bridge-0.1.0.jar");
const fixtureSource = path.join(root, "fixtures/core-mm/v0.0b.mm");
const reportPath = path.join(root, "qualification/reports/v0.0b-local.json");
const manifestPath = path.join(root, "qualification/capabilities/capabilities.json");
const fingerprint = "ff6dab76e60acfb0666ee8ac90dcf2df5bbb1975c2d99eab59ca3f08dcda1822";
const marker = `Freeplane-MCP-GUI-${randomUUID()}`;
const checks = [];
const metrics = {};
let qualificationRoot;
let child;
let discovery;
let stderr = "";
let stdout = "";
let fatalError;
let requestSequence = 0;
let signalledPid;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function firstDifference(expected, actual, location = "$") {
  if (Object.is(expected, actual)) return null;
  if (expected === null || actual === null || typeof expected !== "object" || typeof actual !== "object") {
    return `${location}: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}`.slice(0, 500);
  }
  if (Array.isArray(expected) !== Array.isArray(actual)) return `${location}: container type differs`;
  const expectedKeys = Object.keys(expected);
  const actualKeys = Object.keys(actual);
  if (JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys)) {
    return `${location}: keys expected ${expectedKeys.join(",")}, observed ${actualKeys.join(",")}`.slice(0, 500);
  }
  for (const key of expectedKeys) {
    const difference = firstDifference(expected[key], actual[key], `${location}.${key}`);
    if (difference) return difference;
  }
  return null;
}

function addCheck(id, passed, evidence) {
  checks.push({ id, status: passed ? "pass" : "fail", evidence });
  if (!passed) throw new Error(`${id}: ${evidence}`);
}

function sanitize(value, limit = 2_000) {
  let result = String(value ?? "qualification failed");
  if (discovery?.token) result = result.replaceAll(discovery.token, "[REDACTED_TOKEN]");
  if (qualificationRoot) result = result.replaceAll(qualificationRoot, "$QUALIFICATION_TMP");
  result = result.replaceAll(homedir(), "$HOME");
  return result.slice(0, limit);
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

async function bridgeRequest(method, endpoint, body, options = {}) {
  const headers = {
    ...(options.requestId === false ? {} : { "X-Request-Id": `qualify-${++requestSequence}` }),
    ...(options.auth === false ? {} : { Authorization: `Bearer ${options.token ?? discovery.token}` }),
    ...(method === "POST" ? { "Content-Type": options.contentType ?? "application/json" } : {}),
    ...(options.headers ?? {}),
  };
  const response = await fetch(`http://${discovery.host}:${discovery.port}${endpoint}`, {
    method,
    headers,
    body: body === undefined ? undefined : options.raw ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeout ?? 25_000),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Bridge returned non-JSON status ${response.status}`);
  }
  return { status: response.status, payload };
}

async function must(method, endpoint, body) {
  const response = await bridgeRequest(method, endpoint, body);
  if (response.status !== 200 || response.payload.ok !== true) {
    throw new Error(`${endpoint} failed: ${response.payload.error?.category ?? response.status}`);
  }
  return response.payload.data;
}

function mixedOperations(rootId) {
  const operations = [];
  for (let index = 0; index < 30; index++) {
    operations.push({ type: "create_child", parent: rootId, temp_id: `$c${index}`, text: `child-${index}` });
  }
  for (let index = 0; index < 10; index++) {
    operations.push({ type: "set_text", node: `$c${index}`, value: `renamed-${index}` });
  }
  for (let index = 0; index < 10; index++) {
    operations.push({ type: "set_note", node: `$c${index}`, value: `note-${index}` });
  }
  for (let index = 0; index < 10; index++) {
    operations.push({ type: "set_attribute", node: `$c${index}`, name: "qualification", value: `value-${index}` });
  }
  for (let index = 0; index < 10; index++) {
    operations.push({ type: "set_tags", node: `$c${index}`, tags: ["qualification", `tag-${index}`] });
  }
  for (let index = 0; index < 8; index++) {
    operations.push({ type: "add_icon", node: `$c${index}`, icon: "button_ok" });
  }
  for (let index = 0; index < 8; index++) {
    operations.push({ type: "set_style_background", node: `$c${index}`, color: index % 2 ? "#DDEEFF" : "#FFEECC" });
  }
  operations.push(
    { type: "move_node", node: "$c20", parent: "$c0", position: 0 },
    { type: "move_node", node: "$c21", parent: "$c0", position: 1 },
    { type: "move_node", node: "$c22", parent: "$c1", position: 0 },
    { type: "move_node", node: "$c23", parent: "$c1", position: 1 },
    { type: "move_node", node: "$c24", parent: "$c2", position: 0 },
    { type: "set_folded", node: "$c0", value: true },
    { type: "set_folded", node: "$c1", value: true },
    { type: "set_folded", node: "$c2", value: true },
    { type: "add_connector", source: "$c3", target: "$c7" },
    { type: "add_connector", source: "$c4", target: "$c8" },
    { type: "add_connector", source: "$c5", target: "$c9" },
    { type: "add_connector", source: "$c6", target: "$c10" },
    { type: "delete_node", node: "$c28" },
    { type: "delete_node", node: "$c29" },
  );
  if (operations.length !== 100) throw new Error(`mixed operation fixture has ${operations.length} operations`);
  return operations;
}

async function currentMap() {
  const data = await must("GET", "/v1/maps");
  if (data.maps.length !== 1) throw new Error(`Expected one isolated map, observed ${data.maps.length}`);
  return data.maps[0];
}

async function makePlan(mapId, operations) {
  const summary = await currentMap();
  const plan = await must("POST", "/v1/transactions/plan", {
    map_id: mapId,
    expected_content_revision: summary.content_revision,
    operations,
  });
  return { plan, before: summary };
}

async function history(mapId, action) {
  return must("POST", "/v1/qualification/history", { map_id: mapId, action });
}

async function processCommand(pid) {
  try {
    return (await execFile("/bin/ps", ["-p", String(pid), "-o", "command="])).stdout.trim();
  } catch {
    return "";
  }
}

async function stopIsolatedProcess() {
  const targetPid = Number(discovery?.pid ?? child?.pid);
  if (Number.isInteger(targetPid) && targetPid > 1) {
    const command = await processCommand(targetPid);
    if (targetPid === child?.pid || command.includes(qualificationRoot)) {
      signalledPid = targetPid;
      try { process.kill(targetPid, "SIGTERM"); } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  }
  if (child && child.exitCode === null && child.pid !== signalledPid) {
    signalledPid = child.pid;
    child.kill("SIGTERM");
  }
  if (child && child.exitCode === null) {
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      sleep(8_000),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

try {
  process.stderr.write("v0.0B: building add-on and running pure-Java checks\n");
  await execFile(process.execPath, [path.join(root, "scripts/build_addon.mjs")], {
    cwd: root,
    maxBuffer: 16 * 1024 * 1024,
  });
  addCheck("addon.build_and_self_test", true, "javac --release 17, JAR packaging, and BridgeSelfTest passed");

  qualificationRoot = await mkdtemp(path.join(tmpdir(), "freeplane-mcp-v0.0b-"));
  const userRoot = path.join(qualificationRoot, "user");
  const profile = path.join(userRoot, "1.12.x");
  const runtimeDir = path.join(qualificationRoot, "runtime");
  const workDir = path.join(qualificationRoot, "work");
  const fixture = path.join(workDir, "qualification.mm");
  const initScript = path.join(profile, "scripts/init/00-freeplane-mcp.groovy");
  const uiScript = path.join(qualificationRoot, "ui-edit.groovy");
  const uiReadyFlag = path.join(qualificationRoot, "ui-ready.flag");
  const uiErrorFile = path.join(qualificationRoot, "ui-error.txt");
  await mkdir(path.join(profile, "lib"), { recursive: true });
  await mkdir(path.dirname(initScript), { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  await chmod(runtimeDir, 0o700);
  await mkdir(workDir, { recursive: true });
  await copyFile(addonJar, path.join(profile, "lib", path.basename(addonJar)));
  await copyFile(fixtureSource, fixture);
  const fixtureSourceHashBefore = sha256(await readFile(fixtureSource));
  const fixtureHashBefore = sha256(await readFile(fixture));

  await writeFile(path.join(profile, "auto.properties"), [
    "execute_scripts_without_asking=true",
    "execute_scripts_without_file_restriction=true",
    "execute_scripts_without_network_restriction=true",
    "execute_scripts_without_write_restriction=true",
    "execute_scripts_without_exec_restriction=false",
    "check_updates_automatically=false",
    "",
  ].join("\n"));
  await writeFile(initScript, [
    "import org.freeplanemcp.bridge.FreeplaneBridge",
    `def bridgeStatus = FreeplaneBridge.start((org.freeplane.api.Controller)c, ${JSON.stringify(runtimeDir)}, true, ${JSON.stringify(fingerprint)})`,
    "",
  ].join("\n"));
  await writeFile(uiScript, [
    "import java.awt.event.KeyEvent",
    "import javax.swing.Timer",
    "import org.freeplane.features.text.mindmapmode.IEditorPaneListener",
    "import org.freeplane.features.text.mindmapmode.MTextController",
    "",
    `def marker = ${JSON.stringify(marker)}`,
    `def readyFile = new File(${JSON.stringify(uiReadyFlag)})`,
    `def errorFile = new File(${JSON.stringify(uiErrorFile)})`,
    "def readyTimer = new Timer(50, null)",
    "readyTimer.addActionListener {",
    "    if (!readyFile.exists()) return",
    "    readyTimer.stop()",
    "    def root = c.getOpenMindMaps().get(0).getRoot()",
    "    def textController = MTextController.getController()",
    "    def listenerHolder = new Object[1]",
    "    listenerHolder[0] = [editorPaneCreated: { editor, purpose ->",
    "        textController.removeEditorPaneListener((IEditorPaneListener)listenerHolder[0])",
    "        def submitTimer = new Timer(100, null)",
    "        submitTimer.repeats = false",
    "        submitTimer.addActionListener {",
    "            editor.setText(marker)",
    "            def event = new KeyEvent(editor, KeyEvent.KEY_PRESSED, System.currentTimeMillis(), 0, KeyEvent.VK_ENTER, (char)'\\n')",
    "            def listeners = editor.getKeyListeners()",
    "            if (listeners.length == 0) errorFile.text = 'editor_has_no_key_listener'",
    "            listeners.each { it.keyPressed(event) }",
    "        }",
    "        submitTimer.start()",
    "    }] as IEditorPaneListener",
    "    textController.addEditorPaneListener((IEditorPaneListener)listenerHolder[0])",
    "    c.select(root)",
    "    c.edit(root)",
    "    def watchdog = new Timer(5000, null)",
    "    watchdog.repeats = false",
    "    watchdog.addActionListener { if (root.getText() != marker) errorFile.text = 'editor_commit_not_observed' }",
    "    watchdog.start()",
    "}",
    "readyTimer.start()",
    "",
  ].join("\n"));

  const launchArguments = [`-U${userRoot}`, `-R${uiScript}`, fixture];
  child = spawn(binary, launchArguments, {
    cwd: workDir,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-65_536); });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-65_536); });
  child.once("error", (error) => { fatalError ??= error; });

  discovery = await waitFor(async () => {
    const value = JSON.parse(await readFile(path.join(runtimeDir, "bridge.json"), "utf8"));
    return value.port > 0 ? value : null;
  }, 30_000, "bridge discovery");

  const runtimeMode = (await stat(runtimeDir)).mode & 0o777;
  const discoveryMode = (await stat(path.join(runtimeDir, "bridge.json"))).mode & 0o777;
  addCheck(
    "bridge.discovery_and_binding",
    discovery.host === "127.0.0.1"
      && discovery.port > 0
      && discovery.port !== 6298
      && runtimeMode === 0o700
      && discoveryMode === 0o600,
    "dynamic 127.0.0.1 port; runtime 0700; discovery 0600",
  );
  addCheck(
    "bridge.discovery_identity",
    discovery.freeplane_version === "1.13.3"
      && discovery.freeplane_build_fingerprint === fingerprint
      && discovery.pid === child.pid
      && typeof discovery.bridge_instance_id === "string"
      && discovery.bridge_instance_id.length >= 32
      && Buffer.from(discovery.token, "base64url").length === 32,
    "Freeplane process, instance, version/build, and 256-bit token are pinned",
  );

  const health = await must("GET", "/v1/health");
  addCheck(
    "bridge.health_main_thread",
    health.status === "ok"
      && health.bridge_instance_id === discovery.bridge_instance_id
      && health.registry.main_thread === true
      && health.qualification_mode === true,
    "health completed on the Freeplane main thread in isolated qualification mode",
  );

  const missingToken = await bridgeRequest("GET", "/v1/health", undefined, { auth: false });
  addCheck("bridge.auth_missing", missingToken.status === 401, "missing bearer token was rejected");
  const wrongToken = await bridgeRequest("GET", "/v1/health", undefined, { token: "wrong-token" });
  addCheck("bridge.auth_wrong", wrongToken.status === 401, "wrong bearer token was rejected");
  const browserOrigin = await bridgeRequest("GET", "/v1/health", undefined, { headers: { Origin: "https://example.invalid" } });
  addCheck("bridge.origin_rejected", browserOrigin.status === 403, "browser Origin was rejected without CORS");
  const wrongType = await bridgeRequest("POST", "/v1/read", "{}", { raw: true, contentType: "text/plain" });
  addCheck("bridge.content_type", wrongType.status === 415, "non-JSON POST was rejected");
  const missingRequestId = await bridgeRequest("GET", "/v1/health", undefined, { requestId: false });
  addCheck("bridge.request_id", missingRequestId.status === 400, "missing X-Request-Id was rejected");
  process.stderr.write("v0.0B: checking bounded HTTP body parser\n");
  const oversized = await bridgeRequest(
    "POST",
    "/v1/read",
    JSON.stringify({ payload: "x".repeat(1_024) }),
    { raw: true, headers: { "X-Freeplane-MCP-Qualification-Body-Limit": "1024" } },
  );
  addCheck(
    "bridge.trust_boundary",
    oversized.status === 413,
    "auth, Origin, Content-Type, request-id, and 10 MiB boundary reject invalid requests",
  );

  const maps = await waitFor(async () => {
    const value = await must("GET", "/v1/maps");
    return value.maps.length === 1 ? value.maps : null;
  }, 20_000, "isolated map registry");
  const mapId = maps[0].map_id;
  const initialRead = await must("POST", "/v1/read", { map_id: mapId });
  const rootId = initialRead.content.root.id;
  const cursorBeforeUi = health.registry.cursor;
  await must("POST", "/v1/qualification/ui-ready", { marker });
  await writeFile(uiReadyFlag, "ready\n");
  const uiRead = await waitFor(async () => {
    const value = await must("POST", "/v1/read", { map_id: mapId });
    if (value.content.root.text === marker) return value;
    try {
      const uiError = (await readFile(uiErrorFile, "utf8")).trim();
      if (uiError) throw new Error(`Swing qualification failed: ${uiError}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return null;
  }, 12_000, "Swing inline-editor mutation");
  const healthAfterUi = await must("GET", "/v1/health");
  const uiLatency = healthAfterUi.registry.ui_detection_latency_ms;
  metrics.unsaved_ui_detection_ms = uiLatency;
  addCheck(
    "realtime.unsaved_gui_edit",
    Number.isInteger(uiLatency) && uiLatency >= 0 && uiLatency < 1_000 && uiRead.map.dirty === true,
    `Swing editor change was readable in ${uiLatency} ms without saving`,
  );
  const changes = await must("POST", "/v1/changes", { cursor: cursorBeforeUi, map_id: mapId, limit: 100 });
  addCheck(
    "events.gui_journal",
    changes.events.some((event) => event.source === "user_gui" && event.affected_node_ids.includes(rootId)),
    "GUI mutation was retained in the cursor journal",
  );
  const search = await must("POST", "/v1/search", { map_id: mapId, query: marker, limit: 10 });
  addCheck(
    "read.canonical_and_search",
    search.matches.some((match) => match.node_id === rootId) && uiRead.map.snapshot_sha256.length === 64,
    "canonical read and literal search returned the unsaved root",
  );

  const operations = mixedOperations(rootId);
  const baseline = await currentMap();
  const { plan, before: dryRunBefore } = await makePlan(mapId, operations);
  const dryRunAfter = await currentMap();
  addCheck(
    "transaction.plan_zero_effect",
    dryRunBefore.snapshot_sha256 === dryRunAfter.snapshot_sha256,
    "100-operation plan did not mutate the map",
  );
  const commitStarted = performance.now();
  const committed = await must("POST", "/v1/transactions/commit", {
    plan_id: plan.plan_id,
    plan_hash: plan.plan_hash,
  });
  metrics.mixed_100_commit_ms = Math.round((performance.now() - commitStarted) * 100) / 100;
  const afterCommit = await currentMap();
  addCheck(
    "transaction.mixed_100_commit",
    committed.operation_count === 100
      && committed.effect_status === "verified"
      && afterCommit.snapshot_sha256 === committed.after.snapshot_sha256
      && metrics.mixed_100_commit_ms < 2_000,
    `100 mixed operations committed and read back in ${metrics.mixed_100_commit_ms} ms`,
  );
  const undone = await history(mapId, "undo");
  const undoRead = await must("POST", "/v1/read", { map_id: mapId });
  const undoDifference = firstDifference(uiRead.content, undoRead.content);
  addCheck(
    "transaction.one_compound_undo",
    undone.after_snapshot_sha256 === baseline.snapshot_sha256 && undoDifference === null,
    undoDifference === null
      ? "one Freeplane undo restored the exact pre-transaction canonical snapshot"
      : `undo entry ${JSON.stringify(undone.description)}; ${undoDifference}`,
  );
  const redone = await history(mapId, "redo");
  addCheck(
    "transaction.redo_equivalence",
    redone.after_snapshot_sha256 === afterCommit.snapshot_sha256,
    "one Freeplane redo restored the exact committed canonical snapshot",
  );
  let cleanupUndo = await history(mapId, "undo");
  let cleanupSteps = 1;
  while (cleanupUndo.after_snapshot_sha256 !== baseline.snapshot_sha256 && cleanupSteps < 3) {
    if (cleanupUndo.after_snapshot_sha256 !== afterCommit.snapshot_sha256) {
      throw new Error("redo cleanup produced an unexpected intermediate snapshot");
    }
    cleanupUndo = await history(mapId, "undo");
    cleanupSteps++;
  }
  addCheck(
    "transaction.undo_cleanup",
    cleanupUndo.after_snapshot_sha256 === baseline.snapshot_sha256,
    `qualification map returned to its pre-transaction state in ${cleanupSteps} history step(s)`,
  );

  process.stderr.write("v0.0B: injecting a failure after each of 100 operations\n");
  const failureStarted = performance.now();
  for (let index = 1; index <= operations.length; index++) {
    const planned = await makePlan(mapId, operations);
    const failed = await bridgeRequest("POST", "/v1/transactions/commit", {
      plan_id: planned.plan.plan_id,
      plan_hash: planned.plan.plan_hash,
      failure_after_op: index,
    });
    if (failed.payload.ok !== false
      || failed.payload.error?.category !== "POSTCONDITION_FAILED"
      || failed.payload.error?.details?.rolled_back !== true
      || failed.payload.error?.details?.snapshot_equal !== true) {
      throw new Error(`failure injection ${index} did not produce a verified rollback`);
    }
    const afterFailure = await currentMap();
    if (afterFailure.snapshot_sha256 !== baseline.snapshot_sha256 || afterFailure.recovery_required) {
      throw new Error(`failure injection ${index} left partial state`);
    }
    if (index % 10 === 0) process.stderr.write(`v0.0B: rollback ${index}/100 verified\n`);
    await sleep(5);
  }
  metrics.failure_injection_100_ms = Math.round((performance.now() - failureStarted) * 100) / 100;
  addCheck(
    "transaction.failure_injection_every_operation",
    true,
    `all 100 failure points rolled back to canonical equality in ${metrics.failure_injection_100_ms} ms`,
  );

  const postconditionPlan = await makePlan(mapId, operations);
  const postconditionFailure = await bridgeRequest("POST", "/v1/transactions/commit", {
    plan_id: postconditionPlan.plan.plan_id,
    plan_hash: postconditionPlan.plan.plan_hash,
    failure_mode: "postcondition",
  });
  const afterPostcondition = await currentMap();
  addCheck(
    "transaction.postcondition_failure_rollback",
    postconditionFailure.payload.error?.category === "POSTCONDITION_FAILED"
      && postconditionFailure.payload.error?.details?.snapshot_equal === true
      && afterPostcondition.snapshot_sha256 === baseline.snapshot_sha256,
    "injected postcondition mismatch rolled back to canonical equality",
  );

  const guardOpsA = [{ type: "set_text", node: rootId, value: `${marker}-stale` }];
  const guardOpsB = [{ type: "set_text", node: rootId, value: `${marker}-winner` }];
  const stale = await makePlan(mapId, guardOpsA);
  const winner = await makePlan(mapId, guardOpsB);
  await must("POST", "/v1/transactions/commit", {
    plan_id: winner.plan.plan_id,
    plan_hash: winner.plan.plan_hash,
  });
  const conflict = await bridgeRequest("POST", "/v1/transactions/commit", {
    plan_id: stale.plan.plan_id,
    plan_hash: stale.plan.plan_hash,
  });
  await history(mapId, "undo");
  const afterConflictCleanup = await currentMap();
  addCheck(
    "transaction.revision_conflict_zero_write",
    conflict.status === 409
      && conflict.payload.error?.category === "REVISION_CONFLICT"
      && afterConflictCleanup.snapshot_sha256 === baseline.snapshot_sha256,
    "stale plan was rejected before write and the winning transaction remained one undo unit",
  );

  const fixtureHashAfter = sha256(await readFile(fixture));
  addCheck(
    "isolation.fixture_never_saved",
    fixtureHashAfter === fixtureHashBefore && sha256(await readFile(fixtureSource)) === fixtureSourceHashBefore,
    "all GUI and bridge edits remained unsaved; fixture bytes were unchanged",
  );
} catch (error) {
  fatalError = error;
  if (!checks.some((check) => check.status === "fail")) {
    checks.push({ id: "qualification.fatal", status: "fail", evidence: sanitize(error.message) });
  }
} finally {
  try {
    if (qualificationRoot) await stopIsolatedProcess();
  } catch (error) {
    fatalError ??= error;
    checks.push({ id: "isolation.process_cleanup", status: "fail", evidence: sanitize(error.message) });
  }
}

const passed = !fatalError && checks.length > 0 && checks.every((check) => check.status === "pass");
const report = {
  schema_version: 1,
  stage: "v0.0B",
  generated_at: new Date().toISOString(),
  passed,
  qualification_report: `v0.0b-${fingerprint.slice(0, 12)}`,
  freeplane: {
    version: "1.13.3",
    build_fingerprint: fingerprint,
    addon_version: "0.1.0",
  },
  isolation: {
    temporary_user_profile: true,
    global_profile_modified: false,
    fixture: "fixtures/core-mm/v0.0b.mm",
    spawned_process_only: true,
    signalled_pid_observed: Number.isInteger(signalledPid),
  },
  hard_gate: {
    unsaved_gui_edit_under_1s: checks.some((check) => check.id === "realtime.unsaved_gui_edit" && check.status === "pass"),
    mixed_100_one_undo: checks.some((check) => check.id === "transaction.one_compound_undo" && check.status === "pass"),
    redo_equivalent: checks.some((check) => check.id === "transaction.redo_equivalence" && check.status === "pass"),
    failure_points_verified: checks.some((check) => check.id === "transaction.failure_injection_every_operation" && check.status === "pass") ? 100 : 0,
    rollback_snapshot_equal: checks.some((check) => check.id === "transaction.postcondition_failure_rollback" && check.status === "pass"),
    recovery_required: passed ? false : null,
  },
  metrics,
  checks,
  degradation: {
    mcp_write_tools_registered: false,
    bridge_missing: "v0.0A evidence-only MCP behavior remains active",
    unqualified_build: "bridge installation is refused by the surrounding qualification workflow",
  },
  diagnostics: passed ? null : {
    error: sanitize(fatalError?.message),
    freeplane_stderr_tail: sanitize(stderr.slice(-8_000), 8_000),
    freeplane_stdout_tail: sanitize(stdout.slice(-8_000), 8_000),
  },
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

if (passed) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.generated_at = report.generated_at;
  manifest.addon_version = "0.1.0";
  for (const capability of manifest.capabilities) {
    const mayReplaceEvidence = /^v0\.0[ab]-/.test(capability.qualification_report);
    if (["map.read", "node.read"].includes(capability.capability_id) && mayReplaceEvidence) {
      capability.status = "verified_public_api";
      capability.qualification_report = report.qualification_report;
      capability.evidence = ["v0.0b.unsaved_gui_read", "v0.0b.canonical_snapshot"];
    }
    if (capability.capability_id === "node.update_text" && mayReplaceEvidence) {
      capability.status = "verified_internal_api";
      capability.qualification_report = report.qualification_report;
      capability.evidence = ["v0.0b.mixed_100_compound_undo", "v0.0b.failure_injection_100"];
    }
  }
  if (!manifest.capabilities.some((capability) => capability.capability_id === "map.changes")) {
    manifest.capabilities.push({
      capability_id: "map.changes",
      scope: "read",
      status: "verified_internal_api",
      route: "internal_api",
      risk: "normal",
      freeplane_version: "1.13.3",
      qualification_report: report.qualification_report,
      evidence: ["v0.0b.listener_journal", "v0.0b.snapshot_reconciliation"],
    });
  }
  if (!manifest.capabilities.some((capability) => capability.capability_id === "transaction.atomic_compound_undo")) {
    manifest.capabilities.push({
      capability_id: "transaction.atomic_compound_undo",
      scope: "edit",
      status: "verified_internal_api",
      route: "internal_api",
      risk: "blocked",
      freeplane_version: "1.13.3",
      qualification_report: report.qualification_report,
      evidence: ["v0.0b.mixed_100_compound_undo", "v0.0b.failure_injection_100"],
    });
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

if (qualificationRoot) await rm(qualificationRoot, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({ passed, report: "qualification/reports/v0.0b-local.json", metrics })}\n`);
if (!passed) process.exitCode = 1;
