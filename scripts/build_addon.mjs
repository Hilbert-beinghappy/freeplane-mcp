import { execFile } from "node:child_process";
import { mkdir, opendir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = process.cwd();
const app = process.env.FREEPLANE_APP ?? "/Applications/Freeplane.app";
const runtime = path.join(app, "Contents/runtime/Contents/Home/bin");
const appRoot = path.join(app, "Contents/app");
const cache = process.env.FREEPLANE_MCP_BUILD_DIR
  ?? path.join(homedir(), "Library/Caches/Freeplane-MCP/build/v0.1");
const classes = path.join(cache, "classes");
const testClasses = path.join(cache, "test-classes");
const jar = path.join(cache, "freeplane-mcp-bridge-0.1.0.jar");

async function filesUnder(directory, suffix) {
  const found = [];
  async function visit(current) {
    for await (const entry of await opendir(current)) {
      const candidate = path.join(current, entry.name);
      if (entry.name.startsWith("._")) continue;
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile() && candidate.endsWith(suffix)) found.push(candidate);
    }
  }
  await visit(directory);
  return found.sort();
}

for (const executable of ["java", "javac", "jar"]) {
  await stat(path.join(runtime, executable));
}

const jars = (await filesUnder(appRoot, ".jar")).filter(
  (entry) => !entry.includes("/org.freeplane.plugin.ai/lib/jackson-"),
);
const classpath = jars.join(path.delimiter);
const mainSources = await filesUnder(path.join(root, "addon/src/main/java"), ".java");
const testSources = await filesUnder(path.join(root, "addon/src/test/java"), ".java");
if (mainSources.length === 0 || testSources.length === 0) throw new Error("Add-on Java sources are missing");

await rm(classes, { recursive: true, force: true });
await rm(testClasses, { recursive: true, force: true });
await mkdir(classes, { recursive: true });
await mkdir(testClasses, { recursive: true });

const javac = path.join(runtime, "javac");
await run(javac, [
  "--release", "17",
  "--add-modules", "jdk.httpserver",
  "-encoding", "UTF-8",
  "-classpath", classpath,
  "-d", classes,
  ...mainSources,
], { maxBuffer: 16 * 1024 * 1024 });

await run(javac, [
  "--release", "17",
  "--add-modules", "jdk.httpserver",
  "-encoding", "UTF-8",
  "-classpath", [classes, classpath].join(path.delimiter),
  "-d", testClasses,
  ...testSources,
], { maxBuffer: 16 * 1024 * 1024 });

await run(path.join(runtime, "jar"), ["--create", "--file", jar, "-C", classes, "."]);
const { stdout } = await run(path.join(runtime, "java"), [
  "--add-modules", "jdk.httpserver",
  "-ea",
  "-classpath", [classes, testClasses, classpath].join(path.delimiter),
  "org.freeplanemcp.bridge.BridgeSelfTest",
]);
if (!stdout.includes("BridgeSelfTest: pass")) throw new Error("Bridge self-test did not report success");

const metadata = {
  schema_version: 1,
  addon_version: "0.1.0",
  freeplane_app: app,
  source_count: mainSources.length,
  jar,
};
await writeFile(path.join(cache, "addon-build.json"), `${JSON.stringify(metadata, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ...metadata, self_test: "pass" })}\n`);
