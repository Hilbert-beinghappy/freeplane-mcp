import { spawn } from "node:child_process";
import { copyFile, lstat, mkdir, readlink, symlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const repository = process.cwd();
const cacheRoot =
  process.env.FREEPLANE_MCP_DEV_CACHE ??
  path.join(homedir(), "Library/Caches/Freeplane-MCP/freeplane-mcp-v0");

async function exists(candidate) {
  try {
    return await lstat(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function ensureSymlink(link, target) {
  const current = await exists(link);
  if (current?.isSymbolicLink()) {
    const resolved = path.resolve(path.dirname(link), await readlink(link));
    if (resolved === target) return;
    await unlink(link);
  } else if (current) {
    throw new Error(`${link} exists and is not a symlink; move it manually to protect local work`);
  }
  await mkdir(path.dirname(link), { recursive: true });
  await symlink(target, link, "dir");
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repository, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with status ${code}`)),
    );
  });
}

await mkdir(path.join(cacheRoot, "packages/protocol"), { recursive: true });
await mkdir(path.join(cacheRoot, "packages/server"), { recursive: true });
await Promise.all([
  copyFile(path.join(repository, "package.json"), path.join(cacheRoot, "package.json")),
  copyFile(path.join(repository, "package-lock.json"), path.join(cacheRoot, "package-lock.json")),
  copyFile(
    path.join(repository, "packages/protocol/package.json"),
    path.join(cacheRoot, "packages/protocol/package.json"),
  ),
  copyFile(
    path.join(repository, "packages/server/package.json"),
    path.join(cacheRoot, "packages/server/package.json"),
  ),
]);

await run("npm", ["ci", "--ignore-scripts", "--prefix", cacheRoot]);
await ensureSymlink(path.join(repository, "node_modules"), path.join(cacheRoot, "node_modules"));

for (const packageName of ["protocol", "server"]) {
  const buildDirectory = path.join(cacheRoot, "build", `${packageName}-dist`);
  await mkdir(buildDirectory, { recursive: true });
  await ensureSymlink(path.join(cacheRoot, "packages", packageName, "dist"), buildDirectory);
  await ensureSymlink(path.join(repository, "packages", packageName, "dist"), buildDirectory);
}

process.stdout.write(`Dependencies and build output use ${cacheRoot}\n`);
