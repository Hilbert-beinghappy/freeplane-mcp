import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = process.cwd();
const buildDir = process.env.FREEPLANE_MCP_AX_BUILD_DIR
  ?? path.join(homedir(), "Library/Caches/Freeplane-MCP/ax-helper/v0.5");
const source = path.join(root, "helper/macos-ax/main.swift");
const binary = path.join(buildDir, "freeplane-mcp-ax-helper");

await mkdir(buildDir, { recursive: true, mode: 0o700 });
await chmod(buildDir, 0o700);
await execFile("/usr/bin/xcrun", [
  "swiftc",
  source,
  "-O",
  "-framework", "AppKit",
  "-framework", "ApplicationServices",
  "-o", binary,
], { maxBuffer: 16 * 1024 * 1024 });
await execFile("/usr/bin/codesign", [
  "--force",
  "--sign", "-",
  "--identifier", "com.hilbertbeinghappy.freeplane-mcp.ax-helper",
  binary,
]);
await execFile("/usr/bin/codesign", ["--verify", "--strict", binary]);
const selfTest = JSON.parse((await execFile(binary, [JSON.stringify({
  schema_version: 1,
  command: "self_test",
})])).stdout);
if (selfTest.ok !== true || selfTest.helper_version !== "0.5.0" || selfTest.allowlisted_action_count !== 8) {
  throw new Error("Accessibility helper self-test failed");
}
const bytes = await readFile(binary);
const metadata = {
  schema_version: 1,
  helper_version: "0.5.0",
  identifier: "com.hilbertbeinghappy.freeplane-mcp.ax-helper",
  signature: "adhoc",
  sha256: createHash("sha256").update(bytes).digest("hex"),
  binary,
  self_test: "pass",
};
await writeFile(path.join(buildDir, "ax-helper-build.json"), `${JSON.stringify(metadata, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(metadata)}\n`);
