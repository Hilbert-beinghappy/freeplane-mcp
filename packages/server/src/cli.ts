import { runCodexHostProbe } from "./codexProbe.js";
import { runProbe, writeProbeResult } from "./probe.js";

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "probe") throw new Error("Usage: freeplane-mcp probe [--app /path/Freeplane.app]");
  const freeplaneApp = optionValue(args, "--app");
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
  process.stdout.write(
    `${JSON.stringify({
      passed: result.report.passed,
      report: "qualification/reports/v0.0a-local.json",
      capabilities: "qualification/capabilities/capabilities.json",
      fingerprint: result.report.freeplane.build_fingerprint,
    })}\n`,
  );
  if (!result.report.passed) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Qualification probe failed"}\n`);
  process.exitCode = 1;
}
