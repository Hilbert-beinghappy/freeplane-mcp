import { spawn } from "node:child_process";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const EXPECTED_TOOLS = [
  "freeplane_apply",
  "freeplane_capabilities",
  "freeplane_changes",
  "freeplane_document",
  "freeplane_export",
  "freeplane_history",
  "freeplane_invoke_action",
  "freeplane_list_maps",
  "freeplane_read",
  "freeplane_search",
  "freeplane_status",
  "freeplane_view",
];

export interface CodexHostProbeResult {
  protocol_revision: string;
  server_name: string;
  tool_names: string[];
  tool_call_verified: boolean;
}

async function codexExecutable(): Promise<string> {
  if (process.env.CODEX_CLI) return process.env.CODEX_CLI;
  return (await execFile("/usr/bin/which", ["codex"])).stdout.trim();
}

export async function runCodexHostProbe(root = process.cwd()): Promise<CodexHostProbeResult> {
  const isolatedHome = await mkdtemp(path.join(tmpdir(), "freeplane-mcp-codex-home-"));
  const serverPath = path.join(root, "packages/server/dist/index.js");
  const child = spawn(
    await codexExecutable(),
    [
      "-c",
      `mcp_servers.freeplane_probe.command=${JSON.stringify(process.execPath)}`,
      "-c",
      `mcp_servers.freeplane_probe.args=${JSON.stringify([serverPath])}`,
      "-c",
      `mcp_servers.freeplane_probe.cwd=${JSON.stringify(root)}`,
      "-c",
      "mcp_servers.freeplane_probe.required=true",
      "app-server",
      "--listen",
      "stdio://",
    ],
    {
      cwd: root,
      env: { ...process.env, CODEX_HOME: isolatedHome },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const lines = readline.createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
  let finished = false;
  let rejectProbe: (reason?: unknown) => void = () => {};
  const probeState: { toolNames?: string[]; threadId?: string } = {};

  const probe = new Promise<CodexHostProbeResult>((resolve, reject) => {
    rejectProbe = reject;
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!finished) reject(new Error(`Codex app-server exited ${code}: ${stderr.slice(-1000)}`));
    });
    lines.on("line", (line) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        reject(new Error(`Codex app-server emitted non-JSON stdout: ${line}`));
        return;
      }
      const id = message.id;
      if (id === 0) {
        if (message.error) return reject(new Error(JSON.stringify(message.error)));
        send({ method: "initialized", params: {} });
        send({
          method: "thread/start",
          id: 1,
          params: {
            cwd: root,
            approvalPolicy: "never",
            sandbox: "read-only",
            ephemeral: true,
          },
        });
      } else if (id === 1) {
        if (message.error) return reject(new Error(JSON.stringify(message.error)));
        const thread = (
          message.result as { thread?: { id?: string; ephemeral?: boolean } } | undefined
        )?.thread;
        if (!thread?.id || thread.ephemeral !== true) {
          return reject(new Error("Codex did not return an ephemeral thread"));
        }
        probeState.threadId = thread.id;
        send({
          method: "mcpServerStatus/list",
          id: 2,
          params: { threadId: thread.id, detail: "toolsAndAuthOnly", limit: 20 },
        });
      } else if (id === 2) {
        if (message.error) return reject(new Error(JSON.stringify(message.error)));
        const statuses = (message.result as { data?: Array<Record<string, unknown>> } | undefined)?.data ?? [];
        const status = statuses.find((item) => item.name === "freeplane_probe");
        if (!status) return reject(new Error("Codex did not initialize freeplane_probe"));
        const toolNames = Object.keys((status.tools as Record<string, unknown> | undefined) ?? {}).sort();
        const serverName = (status.serverInfo as { name?: string } | undefined)?.name;
        if (
          serverName !== "freeplane-mcp" ||
          JSON.stringify(toolNames) !== JSON.stringify(EXPECTED_TOOLS)
        ) {
          return reject(new Error("Codex returned an unexpected Freeplane MCP inventory"));
        }
        send({
          method: "mcpServer/tool/call",
          id: 3,
          params: {
            threadId: probeState.threadId,
            server: "freeplane_probe",
            tool: "freeplane_status",
            arguments: {},
          },
        });
        (probeState as { toolNames?: string[] }).toolNames = toolNames;
      } else if (id === 3) {
        if (message.error) return reject(new Error(JSON.stringify(message.error)));
        const result = message.result as { isError?: boolean; structuredContent?: unknown } | undefined;
        const structured = result?.structuredContent as { ok?: boolean; data?: unknown } | undefined;
        if (result?.isError === true || structured?.ok !== true) {
          return reject(new Error("Codex could not call freeplane_status"));
        }
        finished = true;
        resolve({
          protocol_revision: "2025-11-25",
          server_name: "freeplane-mcp",
          tool_names: probeState.toolNames ?? [],
          tool_call_verified: true,
        });
      }
    });
  });
  const timeout = setTimeout(
    () => rejectProbe(new Error(`Codex MCP handshake timed out: ${stderr.slice(-1000)}`)),
    15_000,
  );
  send({
    method: "initialize",
    id: 0,
    params: {
      clientInfo: {
        name: "freeplane_mcp_qualification",
        title: "Freeplane MCP qualification",
        version: "0.0.0",
      },
    },
  });

  try {
    return await probe;
  } finally {
    finished = true;
    clearTimeout(timeout);
    lines.close();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await rm(isolatedHome, { recursive: true, force: true });
  }
}
