import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { ResponseEnvelopeSchema } from "@freeplane-mcp/protocol";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";

const execFile = promisify(execFileCallback);
const root = process.cwd();
const app = process.env.FREEPLANE_APP ?? "/Applications/Freeplane.app";
const binary = path.join(app, "Contents/MacOS/Freeplane");
const buildDir = process.env.FREEPLANE_MCP_BUILD_DIR
  ?? path.join(homedir(), "Library/Caches/Freeplane-MCP/build/v0.1");
const addonJar = path.join(buildDir, "freeplane-mcp-bridge-0.1.0.jar");
const reportPath = path.join(root, "qualification/reports/v0.1-local.json");
const manifestPath = path.join(root, "qualification/capabilities/capabilities.json");
const fingerprint = "ff6dab76e60acfb0666ee8ac90dcf2df5bbb1975c2d99eab59ca3f08dcda1822";
const checks = [];
const metrics = {};
let qualificationRoot;
let child;
let mcpClient;
let transport;
let stderr = "";
let stdout = "";
let fatalError;
let requestSequence = 0;

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

function sanitize(value, limit = 4_000) {
  let result = String(value ?? "qualification failed");
  if (qualificationRoot) result = result.replaceAll(qualificationRoot, "$QUALIFICATION_TMP");
  result = result.replaceAll(homedir(), "$HOME");
  return result.slice(0, limit);
}

function percentile(samples, fraction) {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
}

function metric(cold, hot) {
  const rounded = (value) => Math.round(value * 100) / 100;
  return {
    cold_ms: rounded(cold),
    hot_runs: hot.length,
    p50_ms: rounded(percentile(hot, 0.5)),
    p95_ms: rounded(percentile(hot, 0.95)),
    max_ms: rounded(Math.max(...hot)),
  };
}

async function residentBytes(pid) {
  const { stdout } = await execFile("/bin/ps", ["-p", String(pid), "-o", "rss="]);
  const kibibytes = Number(stdout.trim());
  if (!Number.isFinite(kibibytes) || kibibytes < 1) throw new Error(`could not read RSS for PID ${pid}`);
  return kibibytes * 1024;
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
    await sleep(50);
  }
  throw new Error(`${description} timed out${lastError ? `: ${sanitize(lastError.message)}` : ""}`);
}

async function discovery(runtimeDir) {
  return JSON.parse(await readFile(path.join(runtimeDir, "bridge.json"), "utf8"));
}

async function bridgeRequest(runtimeDir, method, endpoint, body) {
  const active = await discovery(runtimeDir);
  const response = await fetch(`http://127.0.0.1:${active.port}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${active.token}`,
      "X-Request-Id": `v01-${++requestSequence}`,
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  const payload = JSON.parse(await response.text());
  if (!response.ok || payload.ok !== true) {
    throw new Error(`${endpoint} failed: ${payload.error?.category ?? response.status}`);
  }
  return payload.data;
}

async function callTool(name, args = {}) {
  const result = await mcpClient.callTool({ name, arguments: args });
  return { result, envelope: ResponseEnvelopeSchema.parse(result.structuredContent) };
}

async function mustTool(name, args = {}) {
  const value = await callTool(name, args);
  if (value.result.isError === true || !value.envelope.ok) {
    throw new Error(`${name} failed: ${value.envelope.error?.category ?? "unknown"}`);
  }
  return value.envelope;
}

function fixtureXml() {
  const children = [];
  for (let index = 1; index < 5_000; index++) {
    children.push(`<node TEXT="node-${index}" ID="ID_${1_000_000_000 + index}" CREATED="1754006400000" MODIFIED="1754006400000"/>`);
  }
  return `<map version="freeplane 1.12.15">
<!-- Synthetic 5,000-node qualification fixture; contains no user data. -->
<node TEXT="Freeplane MCP v0.1 qualification" FOLDED="false" ID="ID_1000000000" CREATED="1754006400000" MODIFIED="1754006400000">
${children.join("\n")}
</node>
</map>
`;
}

async function stopIsolatedProcess() {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(8_000),
  ]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
  }
}

async function expectFileRejection(readConfiguredMap, candidate, allowedRoots, categories) {
  try {
    await readConfiguredMap(candidate, { files: [candidate], allowedRoots });
    return false;
  } catch (error) {
    return categories.includes(error?.category);
  }
}

try {
  process.stderr.write("v0.1: building TypeScript server and Freeplane add-on\n");
  await execFile("/usr/bin/env", ["npm", "run", "build"], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  await execFile(process.execPath, [path.join(root, "scripts/build_addon.mjs")], {
    cwd: root,
    maxBuffer: 32 * 1024 * 1024,
  });
  addCheck("build.server_and_addon", true, "TypeScript build and Java add-on self-test passed");

  qualificationRoot = await mkdtemp(path.join(tmpdir(), "freeplane-mcp-v0.1-"));
  const userRoot = path.join(qualificationRoot, "user");
  const profile = path.join(userRoot, "1.12.x");
  const runtimeDir = path.join(qualificationRoot, "runtime");
  const workDir = path.join(qualificationRoot, "work");
  const fixture = path.join(workDir, "qualification-5000.mm");
  const initScript = path.join(profile, "scripts/init/00-freeplane-mcp.groovy");
  const uiScript = path.join(qualificationRoot, "ui-driver.groovy");
  const uiCommand = path.join(qualificationRoot, "ui-command.txt");
  const uiDone = path.join(qualificationRoot, "ui-done.txt");
  await Promise.all([
    mkdir(path.join(profile, "lib"), { recursive: true }),
    mkdir(path.dirname(initScript), { recursive: true }),
    mkdir(runtimeDir, { recursive: true }),
    mkdir(workDir, { recursive: true }),
  ]);
  await chmod(runtimeDir, 0o700);
  await copyFile(addonJar, path.join(profile, "lib", path.basename(addonJar)));
  await writeFile(fixture, fixtureXml());
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
  await writeFile(initScript, [
    "import org.freeplanemcp.bridge.FreeplaneBridge",
    `FreeplaneBridge.start((org.freeplane.api.Controller)c, ${JSON.stringify(runtimeDir)}, true, ${JSON.stringify(fingerprint)})`,
    "",
  ].join("\n"));
  await writeFile(uiScript, [
    "import java.awt.event.KeyEvent",
    "import java.awt.KeyboardFocusManager",
    "import java.awt.Window",
    "import javax.swing.Timer",
    "import org.freeplane.features.mode.Controller as ModeController",
    "import org.freeplane.features.text.mindmapmode.IEditorPaneListener",
    "import org.freeplane.features.text.mindmapmode.MTextController",
    "",
    `def commandFile = new File(${JSON.stringify(uiCommand)})`,
    `def doneFile = new File(${JSON.stringify(uiDone)})`,
    "def state = [last: '', busy: false]",
    "def poll = new Timer(50, null)",
    "poll.addActionListener {",
    "    if (state.busy || !commandFile.exists()) return",
    "    def marker = commandFile.text.trim()",
    "    if (!marker || marker == state.last) return",
    "    if (KeyboardFocusManager.currentKeyboardFocusManager.focusOwner == null) {",
    "        def window = Window.windows.find { it.visible }",
    "        window?.toFront()",
    "        window?.requestFocus()",
    "        ModeController.currentController.mapViewManager.obtainFocusForSelected()",
    "        return",
    "    }",
    "    state.busy = true",
    "    state.last = marker",
    "    def root = c.getOpenMindMaps().get(0).getRoot()",
    "    def textController = MTextController.getController()",
    "    def holder = new Object[1]",
    "    holder[0] = [editorPaneCreated: { editor, purpose ->",
    "        textController.removeEditorPaneListener((IEditorPaneListener)holder[0])",
    "        def submit = new Timer(25, null)",
    "        submit.repeats = false",
    "        submit.addActionListener {",
    "            editor.setText(marker)",
    "            def event = new KeyEvent(editor, KeyEvent.KEY_PRESSED, System.currentTimeMillis(), 0, KeyEvent.VK_ENTER, (char)'\\n')",
    "            editor.getKeyListeners().each { it.keyPressed(event) }",
    "            def verify = new Timer(25, null)",
    "            verify.addActionListener {",
    "                if (root.getText() == marker) {",
    "                    verify.stop()",
    "                    doneFile.text = marker",
    "                    state.busy = false",
    "                }",
    "            }",
    "            verify.start()",
    "        }",
    "        submit.start()",
    "    }] as IEditorPaneListener",
    "    textController.addEditorPaneListener((IEditorPaneListener)holder[0])",
    "    c.select(root)",
    "    c.edit(root)",
    "}",
    "poll.start()",
    "",
  ].join("\n"));

  process.stderr.write("v0.1: starting isolated 5,000-node Freeplane instance\n");
  child = spawn(binary, [`-U${userRoot}`, `-R${uiScript}`, fixture], {
    cwd: workDir,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-65_536); });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-65_536); });
  const firstDiscovery = await waitFor(async () => {
    const value = await discovery(runtimeDir);
    return value.port > 0 ? value : null;
  }, 45_000, "bridge discovery");
  const runtimeMode = (await stat(runtimeDir)).mode & 0o777;
  const discoveryMode = (await stat(path.join(runtimeDir, "bridge.json"))).mode & 0o777;
  addCheck(
    "bridge.isolated_identity",
    firstDiscovery.pid === child.pid
      && firstDiscovery.freeplane_build_fingerprint === fingerprint
      && runtimeMode === 0o700
      && discoveryMode === 0o600,
    "isolated child PID, qualified build, 0700 runtime, and 0600 discovery matched",
  );

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "packages/server/dist/index.js")],
    cwd: root,
    env: {
      ...getDefaultEnvironment(),
      FREEPLANE_MCP_RUNTIME_DIR: runtimeDir,
      FREEPLANE_MCP_FILES: JSON.stringify([fixture]),
      FREEPLANE_MCP_ALLOWED_ROOTS: JSON.stringify([workDir]),
    },
    stderr: "pipe",
    maxBufferSize: 64 * 1024 * 1024,
  });
  let mcpStderr = "";
  transport.stderr?.on("data", (chunk) => { mcpStderr += String(chunk); });
  mcpClient = new Client(
    { name: "freeplane-mcp-v0.1-qualification", version: "0.1.0" },
    { supportedProtocolVersions: ["2025-11-25"] },
  );
  await mcpClient.connect(transport);
  const tools = (await mcpClient.listTools()).tools.map((tool) => tool.name).sort();
  addCheck(
    "mcp.read_only_surface",
    JSON.stringify(tools) === JSON.stringify([
      "freeplane_capabilities",
      "freeplane_changes",
      "freeplane_list_maps",
      "freeplane_read",
      "freeplane_search",
      "freeplane_status",
    ]),
    "exactly six qualified read-only tools were registered",
  );

  const statusStarted = performance.now();
  const status = await mustTool("freeplane_status");
  const statusCold = performance.now() - statusStarted;
  const statusHot = [];
  for (let index = 0; index < 20; index++) {
    const started = performance.now();
    const value = await mustTool("freeplane_status");
    statusHot.push(performance.now() - started);
    if (value.authority !== "bridge") throw new Error("status lost bridge authority during hot runs");
  }
  metrics.status = metric(statusCold, statusHot);
  addCheck(
    "realtime.status",
    status.authority === "bridge"
      && status.bridge_instance_id === firstDiscovery.bridge_instance_id
      && status.route.kind === "internal_api"
      && status.data.qualification_report === `v0.1-${fingerprint.slice(0, 12)}`
      && status.data.qualification_passed === true
      && metrics.status.p95_ms < 500,
    `bridge status p95 ${metrics.status.p95_ms} ms (cold ${metrics.status.cold_ms} ms)`,
  );

  const capabilities = await mustTool("freeplane_capabilities");
  const mapReadCapability = capabilities.data.capabilities.find((item) => item.capability_id === "map.read");
  const hiddenEditCapability = capabilities.data.capabilities.find((item) => item.capability_id === "node.update_text");
  addCheck(
    "mcp.capability_honesty",
    capabilities.route.kind === "internal_api"
      && mapReadCapability.available_via_mcp === true
      && hiddenEditCapability.available_via_mcp === false,
    "capability inspection marks qualified read routes available and keeps pre-v0.2 edit internals unavailable via MCP",
  );

  const listed = await mustTool("freeplane_list_maps");
  const maps = listed.data.maps;
  const mapId = maps[0]?.map_id;
  addCheck(
    "read.map_inventory",
    listed.authority === "bridge"
      && maps.length === 1
      && maps[0].active === true
      && maps[0].node_count_estimate === 5_000
      && maps[0].root_node_id === "ID_1000000000",
    "live map inventory reported the active 5,000-node unsaved-capable map",
  );

  const savedInventory = await waitFor(async () => {
    const value = await mustTool("freeplane_list_maps");
    return value.data.maps[0]?.dirty === false ? value : null;
  }, 2_000, "saved map baseline");
  const originalFixtureStat = await stat(fixture);
  await utimes(fixture, originalFixtureStat.atime, new Date(originalFixtureStat.mtimeMs + 5_000));
  await sleep(400);
  const externallyChanged = await waitFor(async () => {
    const value = await mustTool("freeplane_list_maps");
    return value.data.maps[0]?.file_external_change === true ? value : null;
  }, 2_000, "external file change detection");
  await utimes(fixture, originalFixtureStat.atime, originalFixtureStat.mtime);
  addCheck(
    "read.external_file_identity",
    savedInventory.data.maps[0].dirty === false
      && externallyChanged.data.maps[0].file_external_change === true,
    "a saved map retained its baseline across polling and detected an external mtime change",
  );

  const readArguments = {
    map_id: mapId,
    scope: "map",
    depth: 2,
    max_nodes: 5_000,
    fields: ["text", "attributes"],
  };
  const readStarted = performance.now();
  const fullRead = await mustTool("freeplane_read", readArguments);
  const readCold = performance.now() - readStarted;
  const readHot = [];
  for (let index = 0; index < 20; index++) {
    const started = performance.now();
    const value = await mustTool("freeplane_read", readArguments);
    readHot.push(performance.now() - started);
    if (value.data.nodes.length !== 5_000) throw new Error("hot read lost nodes");
  }
  metrics.read_5000 = metric(readCold, readHot);
  const snapshotHealth = await bridgeRequest(runtimeDir, "GET", "/v1/health");
  metrics.snapshot_slice = {
    cold_ms: Math.round(snapshotHealth.registry.max_snapshot_ms * 100) / 100,
    hot_runs: 1,
    p50_ms: Math.round(snapshotHealth.registry.last_snapshot_ms * 100) / 100,
    p95_ms: Math.round(snapshotHealth.registry.max_snapshot_ms * 100) / 100,
    max_ms: Math.round(snapshotHealth.registry.max_snapshot_ms * 100) / 100,
  };
  addCheck(
    "performance.read_5000",
    fullRead.data.nodes.length === 5_000
      && fullRead.data.page.next_cursor === null
      && fullRead.data.unsaved_visibility === true
      && metrics.read_5000.p95_ms < 2_000,
    `5,000-node read p95 ${metrics.read_5000.p95_ms} ms (cold ${metrics.read_5000.cold_ms} ms)`,
  );
  addCheck(
    "performance.snapshot_ui_slice",
    metrics.snapshot_slice.max_ms < 100,
    `maximum measured 5,000-node EDT snapshot slice was ${metrics.snapshot_slice.max_ms} ms`,
  );

  const firstPage = await mustTool("freeplane_read", { ...readArguments, max_nodes: 100 });
  const secondPage = await mustTool("freeplane_read", {
    ...readArguments,
    max_nodes: 100,
    page_cursor: firstPage.data.page.next_cursor,
  });
  const selection = await mustTool("freeplane_read", {
    scope: "selection",
    max_nodes: 10,
    fields: ["text", "links", "encryption"],
  });
  const malformedCursor = `${firstPage.data.page.next_cursor.slice(0, -1)}!`;
  const rejectedPage = await callTool("freeplane_read", {
    ...readArguments,
    max_nodes: 100,
    page_cursor: malformedCursor,
  });
  addCheck(
    "read.scopes_and_pagination",
    firstPage.data.nodes.length === 100
      && secondPage.data.nodes[0].node_id === "ID_1000000100"
      && selection.data.selection_node_ids.includes("ID_1000000000")
      && selection.data.nodes[0].links === null
      && selection.data.nodes[0].encryption.state === "unknown"
      && selection.data.nodes[0].encryption.plaintext_accessible === null
      && rejectedPage.result.isError === true
      && rejectedPage.envelope.error?.category === "VALIDATION_ERROR",
    "map pages, revision-bound cursor validation, and explicit selection IDs passed",
  );

  const searched = await mustTool("freeplane_search", {
    map_id: mapId,
    query: { text: { mode: "literal", value: "NODE-4999", case_sensitive: false } },
    max_results: 10,
    include_snippets: true,
  });
  addCheck(
    "search.structured_literal",
    searched.data.query_mode === "literal"
      && searched.data.matches.length === 1
      && searched.data.matches[0].node_id === "ID_1000004999"
      && searched.route.capability_id === "map.search.literal",
    "bounded structured literal search found the expected node without script or regex evaluation",
  );

  process.stderr.write("v0.1: measuring 20 real Swing edit events\n");
  const eventLatencies = [];
  let lastMarker;
  for (let index = 0; index < 20; index++) {
    const cursorEnvelope = await mustTool("freeplane_changes", { cursor: null, map_id: mapId, limit: 100 });
    let cursor = cursorEnvelope.data.next_cursor;
    const marker = `v01-ui-${index}-${randomUUID()}`;
    const started = performance.now();
    await writeFile(uiCommand, `${marker}\n`);
    const observed = await waitFor(async () => {
      const changes = await mustTool("freeplane_changes", { cursor, map_id: mapId, limit: 100, wait_ms: 750 });
      cursor = changes.data.next_cursor;
      return changes.data.events.some(
        (event) => event.source === "user_gui" && event.affected_node_ids.includes("ID_1000000000"),
      ) ? changes : null;
    }, 3_000, `UI event ${index}`);
    eventLatencies.push(performance.now() - started);
    if (!observed.data.unsaved_visibility) throw new Error("event response lost unsaved visibility");
    await waitFor(async () => (await readFile(uiDone, "utf8")).trim() === marker, 3_000, `UI completion ${index}`);
    lastMarker = marker;
  }
  metrics.event_visibility = metric(eventLatencies[0], eventLatencies.slice(1));
  const unsavedRead = await mustTool("freeplane_read", {
    map_id: mapId,
    scope: "nodes",
    node_ids: ["ID_1000000000"],
    fields: ["text"],
    max_nodes: 1,
  });
  addCheck(
    "realtime.swing_events",
    metrics.event_visibility.p95_ms < 1_000
      && unsavedRead.data.nodes[0].text === lastMarker
      && sha256(await readFile(fixture)) === fixtureHash,
    `real Swing edit event p95 ${metrics.event_visibility.p95_ms} ms; saved fixture bytes unchanged`,
  );

  const syntheticCursor = (await mustTool("freeplane_changes", { cursor: null, map_id: mapId })).data.next_cursor;
  const syntheticMarker = `v01-synthetic-${randomUUID()}`;
  await bridgeRequest(runtimeDir, "POST", "/v1/qualification/silent-text", { map_id: mapId, value: syntheticMarker });
  const reconciled = await waitFor(async () => {
    const changes = await mustTool("freeplane_changes", {
      cursor: syntheticCursor,
      map_id: mapId,
      limit: 100,
      wait_ms: 750,
    });
    return changes.data.events.some((event) => event.kind === "snapshot.reconciled") ? changes : null;
  }, 3_000, "synthetic snapshot reconciliation");
  addCheck(
    "events.synthetic_reconciliation",
    reconciled.data.events.some((event) => event.kind === "snapshot.reconciled"),
    "a deliberately suppressed listener was recovered by snapshot reconciliation",
  );

  const staleCursor = (await mustTool("freeplane_changes", { cursor: null, map_id: mapId })).data.next_cursor;
  const journalRssBefore = await residentBytes(child.pid);
  const journal = await bridgeRequest(runtimeDir, "POST", "/v1/qualification/fill-events", {
    map_id: mapId,
    count: 50_010,
  });
  const journalRssSamples = [];
  for (let index = 0; index < 5; index++) {
    journalRssSamples.push(await residentBytes(child.pid));
    await sleep(50);
  }
  const journalRssAfter = Math.max(...journalRssSamples);
  const journalRssDelta = Math.max(0, journalRssAfter - journalRssBefore);
  metrics.journal_memory = {
    event_count: journal.event_count,
    serialized_bytes: journal.event_bytes,
    rss_before_bytes: journalRssBefore,
    rss_after_bytes: journalRssAfter,
    rss_delta_bytes: journalRssDelta,
    limit_bytes: 64 * 1024 * 1024,
  };
  const expired = await callTool("freeplane_changes", { cursor: staleCursor, map_id: mapId, limit: 10 });
  addCheck(
    "events.bounded_and_expiring",
    journal.event_count <= 50_000
      && journal.event_bytes < 64 * 1024 * 1024
      && journalRssDelta < 64 * 1024 * 1024
      && expired.result.isError === true
      && expired.envelope.error?.category === "CURSOR_EXPIRED"
      && expired.envelope.data.resync_required === true,
    `${journal.event_count} retained events used ${journal.event_bytes} serialized bytes and ${journalRssDelta} RSS bytes; stale cursor forced full resync`,
  );

  const preRestart = await discovery(runtimeDir);
  const restartCursor = (await mustTool("freeplane_changes", { cursor: null, map_id: mapId })).data.next_cursor;
  await bridgeRequest(runtimeDir, "POST", "/v1/qualification/restart", {});
  const restartStarted = performance.now();
  const reconnected = await waitFor(async () => {
    const value = await mustTool("freeplane_status");
    return value.authority === "bridge" && value.bridge_instance_id !== preRestart.bridge_instance_id ? value : null;
  }, 5_000, "in-process bridge reconnect");
  metrics.reconnect = {
    cold_ms: Math.round((performance.now() - restartStarted) * 100) / 100,
    hot_runs: 1,
    p50_ms: Math.round((performance.now() - restartStarted) * 100) / 100,
    p95_ms: Math.round((performance.now() - restartStarted) * 100) / 100,
    max_ms: Math.round((performance.now() - restartStarted) * 100) / 100,
  };
  const mismatch = await callTool("freeplane_changes", { cursor: restartCursor, map_id: mapId, limit: 10 });
  addCheck(
    "bridge.reconnect_and_cursor_instance",
    reconnected.authority === "bridge"
      && metrics.reconnect.max_ms < 2_000
      && mismatch.result.isError === true
      && mismatch.envelope.error?.category === "CURSOR_INSTANCE_MISMATCH",
    `new bridge health appeared in ${metrics.reconnect.max_ms} ms and rejected the old instance cursor`,
  );

  process.stderr.write("v0.1: stopping only the spawned Freeplane process and checking saved-file degradation\n");
  await stopIsolatedProcess();
  const degraded = await waitFor(async () => {
    const value = await mustTool("freeplane_status");
    return value.authority === "file" ? value : null;
  }, 5_000, "file degradation status");
  const fileMaps = await mustTool("freeplane_list_maps");
  const fileMapId = fileMaps.data.maps[0]?.map_id;
  const fileRead = await mustTool("freeplane_read", {
    map_id: fileMapId,
    scope: "nodes",
    node_ids: ["ID_1000000000"],
    fields: ["text", "attributes"],
    max_nodes: 1,
  });
  addCheck(
    "fallback.explicit_saved_authority",
    degraded.data.degraded === true
      && fileMaps.authority === "file"
      && fileRead.authority === "file"
      && fileRead.data.unsaved_visibility === false
      && fileRead.data.nodes[0].text === "Freeplane MCP v0.1 qualification",
    "bridge loss exposed only configured saved bytes with file authority and no unsaved visibility",
  );

  const { readConfiguredMap } = await import("../packages/server/dist/fileFallback.js");
  const hostileRoot = path.join(qualificationRoot, "hostile");
  const outsideRoot = path.join(qualificationRoot, "outside");
  await Promise.all([mkdir(hostileRoot), mkdir(outsideRoot)]);
  const hostiles = new Map([
    ["doctype.mm", `<!DOCTYPE map [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><map><node TEXT="&xxe;"/></map>`],
    ["laughs.mm", `<!DOCTYPE map [<!ENTITY a "ha"><!ENTITY b "&a;&a;&a;&a;">]><map><node TEXT="&b;"/></map>`],
    ["xinclude.mm", `<map xmlns:xi="http://www.w3.org/2001/XInclude"><node><xi:include href="file:///etc/passwd"/></node></map>`],
    ["deep.mm", `<map><node>${"<x>".repeat(257)}${"</x>".repeat(257)}</node></map>`],
    ["long.mm", `<map><node TEXT="${"x".repeat(1_000_001)}"/></map>`],
    ["attrs.mm", `<map><node ${Array.from({ length: 129 }, (_, index) => `A${index}="x"`).join(" ")}/></map>`],
    ["encoding.mm", `<?xml version="1.0" encoding="UTF-16"?><map><node/></map>`],
    ["extra-root.mm", `<map><node ID="ROOT"/></map><extra/>`],
    ["extension-node.mm", `<map><extension><node ID="HIDDEN"/></extension></map>`],
    ["cdata-outside.mm", `<![CDATA[outside]]><map><node ID="ROOT"/></map>`],
    ["spaced-tag.mm", `< map><node ID="ROOT"/></map>`],
  ]);
  for (const [name, value] of hostiles) await writeFile(path.join(hostileRoot, name), value);
  await writeFile(path.join(hostileRoot, "malformed.mm"), Buffer.from([0x3c, 0x6d, 0x61, 0x70, 0x3e, 0xff]));
  const outsideFile = path.join(outsideRoot, "outside.mm");
  await writeFile(outsideFile, `<map><node ID="OUT" TEXT="outside"/></map>`);
  const symlinkFile = path.join(hostileRoot, "link.mm");
  await symlink(outsideFile, symlinkFile);
  const fifo = path.join(hostileRoot, "fifo.mm");
  await execFile("/usr/bin/mkfifo", [fifo]);
  const giant = path.join(hostileRoot, "giant.mm");
  const giantHandle = await open(giant, "w");
  await giantHandle.truncate(50 * 1024 * 1024 + 1);
  await giantHandle.close();
  const rejectionResults = [];
  for (const name of [...hostiles.keys(), "malformed.mm", "link.mm", "fifo.mm", "giant.mm"]) {
    rejectionResults.push(await expectFileRejection(
      readConfiguredMap,
      path.join(hostileRoot, name),
      [hostileRoot],
      ["XML_UNSAFE", "XML_INVALID", "LIMIT_EXCEEDED", "PATH_DENIED"],
    ));
  }
  rejectionResults.push(await expectFileRejection(
    readConfiguredMap,
    outsideFile,
    [hostileRoot],
    ["PATH_DENIED"],
  ));

  let networkRequests = 0;
  const networkServer = createServer((_request, response) => {
    networkRequests++;
    response.end("unexpected");
  });
  await new Promise((resolve) => networkServer.listen(0, "127.0.0.1", resolve));
  const networkPort = networkServer.address().port;
  const networkMap = path.join(hostileRoot, "network.mm");
  await writeFile(networkMap, `<map><node ID="NET" TEXT="safe" LINK="http://127.0.0.1:${networkPort}/must-not-fetch"/></map>`);
  await readConfiguredMap(networkMap, { files: [networkMap], allowedRoots: [hostileRoot] });
  await sleep(100);
  await new Promise((resolve) => networkServer.close(resolve));
  addCheck(
    "fallback.xml_security_matrix",
    rejectionResults.every(Boolean) && networkRequests === 0,
    `${rejectionResults.length} hostile path/XML fixtures rejected; external URL caused ${networkRequests} network requests`,
  );

  addCheck("mcp.stderr_clean", mcpStderr === "", "STDIO server wrote no stderr during qualified calls");
} catch (error) {
  fatalError = error;
  if (!checks.some((check) => check.status === "fail")) {
    checks.push({ id: "qualification.fatal", status: "fail", evidence: sanitize(error.message) });
  }
} finally {
  try {
    if (mcpClient) await mcpClient.close();
  } catch (error) {
    fatalError ??= error;
  }
  try {
    await stopIsolatedProcess();
  } catch (error) {
    fatalError ??= error;
    checks.push({ id: "isolation.process_cleanup", status: "fail", evidence: sanitize(error.message) });
  }
}

const passed = !fatalError && checks.length > 0 && checks.every((check) => check.status === "pass");
const report = {
  schema_version: 1,
  stage: "v0.1",
  generated_at: new Date().toISOString(),
  passed,
  qualification_report: `v0.1-${fingerprint.slice(0, 12)}`,
  freeplane: {
    version: "1.13.3",
    build_fingerprint: fingerprint,
    addon_version: "0.1.0",
  },
  mcp: {
    server_version: "0.1.0",
    protocol_revision: "2025-11-25",
    registered_tools: [
      "freeplane_status",
      "freeplane_capabilities",
      "freeplane_list_maps",
      "freeplane_read",
      "freeplane_search",
      "freeplane_changes",
    ],
    write_tools_registered: false,
  },
  isolation: {
    temporary_user_profile: true,
    global_profile_modified: false,
    generated_fixture_nodes: 5_000,
    spawned_process_only: true,
  },
  hard_gate: {
    status_p95_under_500ms: metrics.status?.p95_ms < 500,
    read_5000_p95_under_2s: metrics.read_5000?.p95_ms < 2_000,
    event_visibility_p95_under_1s: metrics.event_visibility?.p95_ms < 1_000,
    reconnect_under_2s: metrics.reconnect?.max_ms < 2_000,
    snapshot_ui_slice_under_100ms: metrics.snapshot_slice?.max_ms < 100,
    journal_rss_delta_under_64m: metrics.journal_memory?.rss_delta_bytes < 64 * 1024 * 1024,
    file_fallback_excludes_unsaved_state: true,
    regex_disabled: true,
  },
  metrics,
  checks,
  diagnostics: passed ? null : {
    error: sanitize(fatalError?.message),
    freeplane_stderr_tail: sanitize(stderr.slice(-12_000), 12_000),
    freeplane_stdout_tail: sanitize(stdout.slice(-12_000), 12_000),
  },
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

if (passed) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.generated_at = report.generated_at;
  manifest.addon_version = "0.1.0";
  const qualified = new Map([
    ["runtime.status", ["verified_internal_api", "internal_api", ["v0.1.status_latency", "v0.1.bridge_degradation"]]],
    ["runtime.capabilities", ["verified_internal_api", "internal_api", ["v0.1.six_tool_inventory"]]],
    ["map.read", ["verified_public_api", "public_api", ["v0.1.read_5000", "v0.1.live_unsaved_read", "v0.1.file_fallback"]]],
    ["node.read", ["verified_public_api", "public_api", ["v0.1.scopes_pagination", "v0.1.ordered_attributes"]]],
    ["map.changes", ["verified_internal_api", "internal_api", ["v0.1.event_p95", "v0.1.cursor_resync", "v0.1.journal_bound"]]],
    ["map.list", ["verified_public_api", "public_api", ["v0.1.live_map_inventory"]]],
    ["map.selection", ["verified_public_api", "public_api", ["v0.1.selection_scope"]]],
    ["map.search.literal", ["verified_public_api", "public_api", ["v0.1.structured_literal_search"]]],
    ["map.file_read", ["file_read", "file", ["v0.1.xml_security_matrix", "v0.1.explicit_file_authority"]]],
  ]);
  for (const [capabilityId, [status, route, evidence]] of qualified) {
    let capability = manifest.capabilities.find((item) => item.capability_id === capabilityId);
    if (!capability) {
      capability = {
        capability_id: capabilityId,
        scope: "read",
        status,
        route,
        risk: "normal",
        freeplane_version: "1.13.3",
        qualification_report: report.qualification_report,
        evidence,
      };
      manifest.capabilities.push(capability);
    } else {
      Object.assign(capability, {
        status,
        route,
        qualification_report: report.qualification_report,
        evidence,
      });
    }
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

if (qualificationRoot) await rm(qualificationRoot, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({ passed, report: "qualification/reports/v0.1-local.json", metrics })}\n`);
if (!passed) process.exitCode = 1;
