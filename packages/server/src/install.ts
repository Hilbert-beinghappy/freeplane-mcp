import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { CapabilityManifestSchema } from "@freeplane-mcp/protocol";

import { discoverFreeplaneApp, runProbe } from "./probe.js";

export const RELEASE_VERSION = "1.0.0";
export const INSTALL_MANIFEST = ".freeplane-mcp-install.json";
const PROFILE_DIRECTORY = "1.12.x";
const SHA256 = /^[a-f0-9]{64}$/;

interface ManagedFile {
  root: "prefix" | "profile";
  path: string;
  sha256: string;
  size: number;
  mode: number;
}

export interface InstallationManifest {
  schema_version: 1;
  version: string;
  prefix: string;
  freeplane_user_directory: string;
  runtime_directory: string;
  freeplane_app: string;
  freeplane_build_fingerprint: string;
  capability_manifest_sha256: string;
  package_lock_sha256: string;
  installed_at: string;
  managed_files: ManagedFile[];
}

export interface InstallOptions {
  allowExistingProfile: boolean;
  apply: boolean;
  freeplaneApp?: string;
  capabilityManifestPath?: string;
  freeplaneUserDirectory: string;
  prefix: string;
  runtimeDirectory: string;
  sourceRoot: string;
}

export interface InstallationInspection {
  state: "absent" | "verified" | "modified";
  manifest: InstallationManifest | null;
  checked_files: number;
  problems: string[];
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fileDigest(target: string): Promise<{ sha256: string; size: number; mode: number }> {
  const entry = await lstat(target).catch(() => null);
  if (
    !entry?.isFile()
    || entry.isSymbolicLink()
    || (typeof process.getuid === "function" && entry.uid !== process.getuid())
  ) throw new Error(`Managed path is not a user-owned regular file: ${target}`);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = await handle.readFile();
    return { sha256: digest(bytes), size: bytes.length, mode: entry.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

function exactDirectory(value: string, label: string): string {
  if (!path.isAbsolute(value) || path.normalize(value) !== value) {
    throw new Error(`${label} must be a normalized absolute path`);
  }
  const root = path.parse(value).root;
  const home = homedir();
  if (value === root || value === home) throw new Error(`${label} is too broad`);
  return value;
}

function exactFile(value: string, label: string): string {
  if (!path.isAbsolute(value) || path.normalize(value) !== value || value === path.parse(value).root) {
    throw new Error(`${label} must be a normalized absolute file path`);
  }
  return value;
}

async function ensureOwnedDirectory(target: string, privateDirectory: boolean): Promise<void> {
  await mkdir(target, { recursive: true, mode: 0o700 });
  const entry = await lstat(target);
  if (
    !entry.isDirectory()
    || entry.isSymbolicLink()
    || (entry.mode & 0o022) !== 0
    || (privateDirectory && (entry.mode & 0o077) !== 0)
    || (typeof process.getuid === "function" && entry.uid !== process.getuid())
  ) throw new Error(`Install directory has unsafe metadata: ${target}`);
}

function contained(root: string, relative: string): string {
  if (relative.length === 0 || path.isAbsolute(relative) || path.normalize(relative) !== relative || relative.startsWith(`..${path.sep}`)) {
    throw new Error("Install manifest contains an unsafe relative path");
  }
  const target = path.join(root, relative);
  if (path.relative(root, target).startsWith("..")) throw new Error("Install manifest path escapes its root");
  return target;
}

function validateRoots(prefix: string, profile: string, runtime: string): void {
  for (const [leftName, left, rightName, right] of [
    ["prefix", prefix, "profile", profile],
    ["prefix", prefix, "runtime", runtime],
    ["profile", profile, "runtime", runtime],
  ] as const) {
    if (left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`)) {
      throw new Error(`${leftName} and ${rightName} directories must not overlap`);
    }
  }
}

function isManifest(value: unknown): value is InstallationManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const valid = item.schema_version === 1
    && item.version === RELEASE_VERSION
    && typeof item.prefix === "string"
    && typeof item.freeplane_user_directory === "string"
    && typeof item.runtime_directory === "string"
    && typeof item.freeplane_app === "string"
    && path.isAbsolute(item.freeplane_app)
    && path.normalize(item.freeplane_app) === item.freeplane_app
    && typeof item.freeplane_build_fingerprint === "string"
    && SHA256.test(item.freeplane_build_fingerprint)
    && typeof item.capability_manifest_sha256 === "string"
    && SHA256.test(item.capability_manifest_sha256)
    && typeof item.package_lock_sha256 === "string"
    && SHA256.test(item.package_lock_sha256)
    && typeof item.installed_at === "string"
    && Number.isFinite(Date.parse(item.installed_at))
    && Array.isArray(item.managed_files)
    && item.managed_files.length > 0
    && item.managed_files.every((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      const file = entry as Record<string, unknown>;
      return (file.root === "prefix" || file.root === "profile")
        && typeof file.path === "string"
        && typeof file.sha256 === "string" && SHA256.test(file.sha256)
        && Number.isInteger(file.size) && (file.size as number) >= 0
        && Number.isInteger(file.mode) && (file.mode as number) >= 0 && (file.mode as number) <= 0o777;
    });
  if (!valid) return false;
  const managed = item.managed_files as ManagedFile[];
  return new Set(managed.map((file) => `${file.root}\0${file.path}`)).size === managed.length;
}

async function walkFiles(root: string, current = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.name.startsWith("._")) continue;
    const target = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlinks are not allowed in a release install: ${target}`);
    if (entry.isDirectory()) files.push(...await walkFiles(root, target));
    else if (entry.isFile()) files.push(path.relative(root, target));
    else throw new Error(`Unsupported release input: ${target}`);
  }
  return files.sort();
}

async function copyTree(source: string, destination: string): Promise<void> {
  const canonicalSource = await realpath(source);
  const sourceEntry = await lstat(canonicalSource);
  if (!sourceEntry.isDirectory() || sourceEntry.isSymbolicLink()) throw new Error(`Release source is not a directory: ${source}`);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const relative of await walkFiles(canonicalSource)) {
    const target = path.join(destination, relative);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(path.join(canonicalSource, relative), target);
  }
}

async function applyPrivateModes(root: string, executableFiles: Set<string>): Promise<void> {
  const visit = async (current: string): Promise<void> => {
    await chmod(current, 0o700);
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) await chmod(target, executableFiles.has(path.relative(root, target)) ? 0o700 : 0o600);
      else throw new Error(`Installed release contains a non-regular path: ${target}`);
    }
  };
  await visit(root);
}

async function managedPrefixFiles(staging: string): Promise<ManagedFile[]> {
  const files = await walkFiles(staging);
  return Promise.all(files
    .filter((relative) => relative !== INSTALL_MANIFEST)
    .map(async (relative) => ({ root: "prefix" as const, path: relative, ...(await fileDigest(path.join(staging, relative))) })));
}

function launcherSource(prefix: string, runtime: string, helper: string): string {
  return `#!/usr/bin/env node\nprocess.chdir(${JSON.stringify(prefix)});\nprocess.env.FREEPLANE_MCP_RUNTIME_DIR ??= ${JSON.stringify(runtime)};\nprocess.env.FREEPLANE_MCP_AX_HELPER ??= ${JSON.stringify(helper)};\nawait import(new URL(\"../packages/server/dist/index.js\", import.meta.url));\n`;
}

function cliLauncherSource(prefix: string, runtime: string, helper: string): string {
  return `#!/usr/bin/env node\nprocess.chdir(${JSON.stringify(prefix)});\nprocess.env.FREEPLANE_MCP_INSTALL_ROOT ??= ${JSON.stringify(prefix)};\nprocess.env.FREEPLANE_MCP_RUNTIME_DIR ??= ${JSON.stringify(runtime)};\nprocess.env.FREEPLANE_MCP_AX_HELPER ??= ${JSON.stringify(helper)};\nawait import(new URL(\"../packages/server/dist/cli.js\", import.meta.url));\n`;
}

function freeplaneLauncherSource(app: string, profile: string, startupScript: string): string {
  const binary = path.join(app, "Contents", "MacOS", "Freeplane");
  return `#!/usr/bin/env node\nimport { spawn } from \"node:child_process\";\nconst child = spawn(${JSON.stringify(binary)}, [${JSON.stringify(`-U${profile}`)}, ${JSON.stringify(`-R${startupScript}`)}, ...process.argv.slice(2)], { stdio: \"inherit\" });\nfor (const signal of [\"SIGINT\", \"SIGTERM\"]) process.on(signal, () => child.kill(signal));\nconst [code, signal] = await new Promise((resolve) => child.once(\"exit\", (code, signal) => resolve([code, signal])));\nif (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1;\n`;
}

async function buildStaging(options: InstallOptions, staging: string, app: string): Promise<{
  capabilityHash: string;
  fingerprint: string;
  helper: string;
  jar: string;
  lockHash: string;
}> {
  const source = options.sourceRoot;
  const packageValue = JSON.parse(await readFile(path.join(source, "package.json"), "utf8")) as { version?: string };
  if (packageValue.version !== RELEASE_VERSION) throw new Error(`Source version must be ${RELEASE_VERSION}`);
  const capabilitySource = options.capabilityManifestPath
    ? exactFile(options.capabilityManifestPath, "capability manifest")
    : path.join(source, "qualification/capabilities/capabilities.json");
  const capabilityBytes = await readFile(capabilitySource);
  const capability = CapabilityManifestSchema.parse(JSON.parse(capabilityBytes.toString("utf8")));
  if (capability.addon_version !== RELEASE_VERSION) throw new Error("Capability manifest is not promoted to v1.0");
  const release = RELEASE_VERSION.split(".").slice(0, 2).join(".");
  const addonBuild = process.env.FREEPLANE_MCP_BUILD_DIR
    ?? path.join(homedir(), `Library/Caches/Freeplane-MCP/build/v${release}`);
  const helperBuild = process.env.FREEPLANE_MCP_AX_BUILD_DIR
    ?? path.join(homedir(), `Library/Caches/Freeplane-MCP/ax-helper/v${release}`);
  const jar = path.join(addonBuild, `freeplane-mcp-bridge-${RELEASE_VERSION}.jar`);
  const helperSource = path.join(helperBuild, "freeplane-mcp-ax-helper");
  await Promise.all([stat(jar), stat(helperSource), stat(path.join(app, "Contents/MacOS/Freeplane"))]);

  await Promise.all([
    copyTree(path.join(source, "packages/server/dist"), path.join(staging, "packages/server/dist")),
    copyTree(path.join(source, "packages/protocol/dist"), path.join(staging, "node_modules/@freeplane-mcp/protocol/dist")),
    copyTree(path.join(source, "node_modules/@modelcontextprotocol/server"), path.join(staging, "node_modules/@modelcontextprotocol/server")),
    copyTree(path.join(source, "node_modules/@modelcontextprotocol/core"), path.join(staging, "node_modules/@modelcontextprotocol/core")),
    copyTree(path.join(source, "node_modules/zod"), path.join(staging, "node_modules/zod")),
    copyTree(path.join(source, "qualification"), path.join(staging, "qualification")),
    copyTree(path.join(source, "docs"), path.join(staging, "docs")),
  ]);
  await copyFile(capabilitySource, path.join(staging, "qualification/capabilities/capabilities.json"));
  await mkdir(path.join(staging, "node_modules/@freeplane-mcp/protocol"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(staging, "libexec"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(staging, "bin"), { recursive: true, mode: 0o700 });
  await Promise.all([
    copyFile(path.join(source, "packages/protocol/package.json"), path.join(staging, "node_modules/@freeplane-mcp/protocol/package.json")),
    copyFile(path.join(source, "package-lock.json"), path.join(staging, "package-lock.json")),
    copyFile(path.join(source, "LICENSE"), path.join(staging, "LICENSE")),
    copyFile(path.join(source, "README.md"), path.join(staging, "README.md")),
    copyFile(path.join(source, "SECURITY.md"), path.join(staging, "SECURITY.md")),
    copyFile(path.join(source, "THIRD_PARTY_NOTICES.md"), path.join(staging, "THIRD_PARTY_NOTICES.md")),
    copyFile(helperSource, path.join(staging, "libexec/freeplane-mcp-ax-helper")),
  ]);
  await writeFile(path.join(staging, "package.json"), `${JSON.stringify({
    name: "freeplane-mcp-local",
    version: RELEASE_VERSION,
    private: true,
    type: "module",
  }, null, 2)}\n`, { mode: 0o600 });
  const startupScript = path.join(options.prefix, "libexec/start-freeplane-mcp.groovy");
  await writeFile(path.join(staging, "libexec/start-freeplane-mcp.groovy"), [
    "import org.freeplanemcp.bridge.FreeplaneBridge",
    `FreeplaneBridge.start((org.freeplane.api.Controller)c, ${JSON.stringify(options.runtimeDirectory)}, false, ${JSON.stringify(capability.freeplane_build_fingerprint)})`,
    "",
  ].join("\n"), { mode: 0o600 });
  const helper = path.join(options.prefix, "libexec/freeplane-mcp-ax-helper");
  await Promise.all([
    writeFile(path.join(staging, "bin/freeplane-mcp"), launcherSource(options.prefix, options.runtimeDirectory, helper)),
    writeFile(path.join(staging, "bin/freeplane-mcp-cli"), cliLauncherSource(options.prefix, options.runtimeDirectory, helper)),
    writeFile(path.join(staging, "bin/freeplane-mcp-freeplane"), freeplaneLauncherSource(app, options.freeplaneUserDirectory, startupScript)),
  ]);
  await applyPrivateModes(staging, new Set([
    "bin/freeplane-mcp",
    "bin/freeplane-mcp-cli",
    "bin/freeplane-mcp-freeplane",
    "libexec/freeplane-mcp-ax-helper",
  ]));
  return {
    capabilityHash: digest(capabilityBytes),
    fingerprint: capability.freeplane_build_fingerprint,
    helper,
    jar,
    lockHash: digest(await readFile(path.join(source, "package-lock.json"))),
  };
}

async function directoryHasEntries(target: string): Promise<boolean> {
  const entry = await lstat(target).catch(() => null);
  if (!entry) return false;
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Expected a real directory: ${target}`);
  return (await readdir(target)).some((name) => !name.startsWith("._"));
}

export function defaultInstallPaths(env: NodeJS.ProcessEnv = process.env) {
  const base = env.FREEPLANE_MCP_HOME
    ?? path.join(homedir(), "Library", "Application Support", "Freeplane-MCP");
  return {
    prefix: path.join(base, "install"),
    freeplaneUserDirectory: path.join(base, "freeplane-user"),
    runtimeDirectory: path.join(base, "runtime"),
  };
}

export async function inspectInstallation(prefixValue: string): Promise<InstallationInspection> {
  const prefix = exactDirectory(prefixValue, "prefix");
  const manifestPath = path.join(prefix, INSTALL_MANIFEST);
  const entry = await lstat(manifestPath).catch(() => null);
  if (!entry) return { state: "absent", manifest: null, checked_files: 0, problems: [] };
  const problems: string[] = [];
  if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0 || entry.size > 4 * 1024 * 1024) {
    return { state: "modified", manifest: null, checked_files: 0, problems: ["install manifest metadata is unsafe"] };
  }
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    return { state: "modified", manifest: null, checked_files: 0, problems: ["install manifest is unreadable"] };
  }
  if (!isManifest(manifestValue)) {
    return { state: "modified", manifest: null, checked_files: 0, problems: ["install manifest schema is invalid"] };
  }
  const manifest = manifestValue;
  try {
    const profile = exactDirectory(manifest.freeplane_user_directory, "profile");
    const runtime = exactDirectory(manifest.runtime_directory, "runtime");
    if (manifest.prefix !== prefix) throw new Error("manifest prefix does not match its location");
    validateRoots(prefix, profile, runtime);
    const expectedPrefix = new Set([INSTALL_MANIFEST]);
    for (const managed of manifest.managed_files) {
      const root = managed.root === "prefix" ? prefix : profile;
      const target = contained(root, managed.path);
      if (managed.root === "prefix" && managed.path === INSTALL_MANIFEST) {
        throw new Error("install manifest cannot own itself");
      }
      if (managed.root === "prefix") expectedPrefix.add(managed.path);
      try {
        const actual = await fileDigest(target);
        if (actual.sha256 !== managed.sha256 || actual.size !== managed.size || actual.mode !== managed.mode) {
          problems.push(`${managed.root}:${managed.path} differs from the install manifest`);
        }
      } catch {
        problems.push(`${managed.root}:${managed.path} is missing or unsafe`);
      }
    }
    const actualPrefix = new Set(await walkFiles(prefix));
    for (const relative of actualPrefix) if (!expectedPrefix.has(relative)) problems.push(`prefix:${relative} is unowned`);
    for (const relative of expectedPrefix) if (!actualPrefix.has(relative)) problems.push(`prefix:${relative} is missing`);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : "install manifest roots are unsafe");
  }
  return {
    state: problems.length === 0 ? "verified" : "modified",
    manifest,
    checked_files: manifest.managed_files.length,
    problems: problems.slice(0, 20),
  };
}

export async function installLocal(options: InstallOptions) {
  const prefix = exactDirectory(options.prefix, "prefix");
  const profile = exactDirectory(options.freeplaneUserDirectory, "profile");
  const runtime = exactDirectory(options.runtimeDirectory, "runtime");
  const source = exactDirectory(options.sourceRoot, "source root");
  validateRoots(prefix, profile, runtime);
  const normalized = { ...options, prefix, freeplaneUserDirectory: profile, runtimeDirectory: runtime, sourceRoot: source };
  const existing = await inspectInstallation(prefix);
  if (existing.state !== "absent") {
    const capabilitySource = options.capabilityManifestPath
      ? exactFile(options.capabilityManifestPath, "capability manifest")
      : path.join(source, "qualification/capabilities/capabilities.json");
    const expectedCapabilityHash = digest(await readFile(capabilitySource));
    if (
      existing.state === "verified"
      && existing.manifest?.freeplane_user_directory === profile
      && existing.manifest.runtime_directory === runtime
      && existing.manifest.capability_manifest_sha256 === expectedCapabilityHash
    ) return { schema_version: 1, action: "install", effect: "unchanged", version: RELEASE_VERSION, files: existing.checked_files };
    throw new Error(`Existing installation is not reusable: ${existing.problems.join("; ") || "configuration differs"}`);
  }
  if (!options.allowExistingProfile && await directoryHasEntries(profile)) {
    throw new Error("Freeplane user directory is not clean; pass --allow-existing-profile only after reviewing it");
  }
  const profileJarRelative = path.join(PROFILE_DIRECTORY, "lib", `freeplane-mcp-bridge-${RELEASE_VERSION}.jar`);
  const profileJar = path.join(profile, profileJarRelative);
  if (await lstat(profileJar).catch(() => null)) throw new Error(`Profile add-on already exists: ${profileJar}`);
  const app = await discoverFreeplaneApp(options.freeplaneApp);
  const compatibility = await runProbe({
    root: source,
    freeplaneApp: app,
    freeplaneUserDirectory: profile,
  });
  const incompatible = compatibility.report.checks.filter(
    (check) => check.status === "fail" && check.id !== "protocol.codex_stdio_handshake",
  );
  if (incompatible.length > 0) {
    throw new Error(`Freeplane compatibility probe failed: ${incompatible.map((check) => check.id).join(", ")}`);
  }
  if (!options.apply) {
    return {
      schema_version: 1,
      action: "install",
      effect: "planned",
      version: RELEASE_VERSION,
      prefix,
      freeplane_user_directory: profile,
      runtime_directory: runtime,
      freeplane_app: app,
    };
  }

  await ensureOwnedDirectory(path.dirname(prefix), false);
  const staging = await mkdtemp(path.join(path.dirname(prefix), ".freeplane-mcp-install-"));
  let prefixPublished = false;
  let profileJarPublished = false;
  try {
    const built = await buildStaging(normalized, staging, app);
    const jarMetadata = await fileDigest(built.jar);
    const managed = [
      ...await managedPrefixFiles(staging),
      { root: "profile" as const, path: profileJarRelative, ...jarMetadata, mode: 0o600 },
    ];
    const manifest: InstallationManifest = {
      schema_version: 1,
      version: RELEASE_VERSION,
      prefix,
      freeplane_user_directory: profile,
      runtime_directory: runtime,
      freeplane_app: app,
      freeplane_build_fingerprint: built.fingerprint,
      capability_manifest_sha256: built.capabilityHash,
      package_lock_sha256: built.lockHash,
      installed_at: new Date().toISOString(),
      managed_files: managed.sort((left, right) => `${left.root}/${left.path}`.localeCompare(`${right.root}/${right.path}`)),
    };
    await writeFile(path.join(staging, INSTALL_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(path.join(staging, INSTALL_MANIFEST), 0o600);
    await rename(staging, prefix);
    prefixPublished = true;

    await ensureOwnedDirectory(path.dirname(profile), false);
    await ensureOwnedDirectory(profile, false);
    await ensureOwnedDirectory(path.join(profile, PROFILE_DIRECTORY), false);
    await ensureOwnedDirectory(path.dirname(profileJar), false);
    const jarTemporary = path.join(path.dirname(profileJar), `.freeplane-mcp-${randomUUID()}.jar`);
    await copyFile(built.jar, jarTemporary);
    await chmod(jarTemporary, 0o600);
    if ((await fileDigest(jarTemporary)).sha256 !== jarMetadata.sha256) throw new Error("Staged add-on hash diverged");
    await rename(jarTemporary, profileJar);
    profileJarPublished = true;
    await ensureOwnedDirectory(path.dirname(runtime), false);
    await ensureOwnedDirectory(runtime, true);
    const inspection = await inspectInstallation(prefix);
    if (inspection.state !== "verified") throw new Error(`Installed files failed readback: ${inspection.problems.join("; ")}`);
    return { schema_version: 1, action: "install", effect: "verified", version: RELEASE_VERSION, files: inspection.checked_files };
  } catch (error) {
    if (profileJarPublished) await unlink(profileJar).catch(() => undefined);
    if (prefixPublished) await rm(prefix, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function uninstallLocal(prefixValue: string, apply: boolean) {
  const prefix = exactDirectory(prefixValue, "prefix");
  const inspection = await inspectInstallation(prefix);
  if (inspection.state !== "verified" || !inspection.manifest) {
    throw new Error(`Uninstall refused: ${inspection.problems.join("; ") || "no verified installation"}`);
  }
  const profile = exactDirectory(inspection.manifest.freeplane_user_directory, "profile");
  const profileFiles = inspection.manifest.managed_files.filter((file) => file.root === "profile");
  if (profileFiles.length !== 1) throw new Error("Uninstall manifest has an unexpected profile file set");
  const profileJar = contained(profile, profileFiles[0]!.path);
  if (!apply) {
    return { schema_version: 1, action: "uninstall", effect: "planned", version: RELEASE_VERSION, files: inspection.checked_files };
  }
  const suffix = randomUUID();
  const jarStaging = path.join(path.dirname(profileJar), `.freeplane-mcp-uninstall-${suffix}.jar`);
  const prefixStaging = path.join(path.dirname(prefix), `.freeplane-mcp-uninstall-${suffix}`);
  let jarMoved = false;
  let prefixMoved = false;
  try {
    await rename(profileJar, jarStaging);
    jarMoved = true;
    await rename(prefix, prefixStaging);
    prefixMoved = true;
  } catch (error) {
    if (prefixMoved) await rename(prefixStaging, prefix).catch(() => undefined);
    if (jarMoved) await rename(jarStaging, profileJar).catch(() => undefined);
    throw error;
  }
  await Promise.all([unlink(jarStaging), rm(prefixStaging, { recursive: true, force: false })]);
  for (const directory of [path.dirname(profileJar), path.dirname(path.dirname(profileJar)), profile]) {
    await rmdir(directory).catch(() => undefined);
  }
  return { schema_version: 1, action: "uninstall", effect: "verified", version: RELEASE_VERSION, files: inspection.checked_files };
}
