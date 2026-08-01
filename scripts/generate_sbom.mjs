import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
const packageMetadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
if (packageMetadata.license !== "MIT" || packageMetadata.author !== "Hilbert-beinghappy") {
  throw new Error("Project license metadata must match the public MIT release");
}
const dependencyPaths = [
  "node_modules/@modelcontextprotocol/server",
  "node_modules/@modelcontextprotocol/core",
  "node_modules/zod",
];
const packages = [{
  SPDXID: "SPDXRef-Package-Freeplane-MCP",
  name: "freeplane-mcp",
  versionInfo: packageMetadata.version,
  downloadLocation: "NOASSERTION",
  filesAnalyzed: false,
  licenseConcluded: packageMetadata.license,
  licenseDeclared: packageMetadata.license,
  copyrightText: `Copyright (c) 2026 ${packageMetadata.author}`,
}, ...dependencyPaths.map((packagePath) => {
  const metadata = lock.packages[packagePath];
  if (!metadata?.version || !metadata.resolved || !metadata.integrity) throw new Error(`Lockfile package is incomplete: ${packagePath}`);
  const name = packagePath.slice("node_modules/".length);
  const integrity = /^(sha(?:256|384|512))-([A-Za-z0-9+/]+={0,2})$/.exec(metadata.integrity);
  if (!integrity) throw new Error(`Lockfile integrity is unsupported: ${packagePath}`);
  return {
    SPDXID: `SPDXRef-Package-${name.replace(/[^A-Za-z0-9.-]/g, "-")}`,
    name,
    versionInfo: metadata.version,
    downloadLocation: metadata.resolved,
    filesAnalyzed: false,
    licenseConcluded: "MIT",
    licenseDeclared: "MIT",
    copyrightText: "NOASSERTION",
    externalRefs: [{
      referenceCategory: "PACKAGE-MANAGER",
      referenceType: "purl",
      referenceLocator: `pkg:npm/${encodeURIComponent(name).replace("%2F", "/")}@${metadata.version}`,
    }],
    checksums: [{ algorithm: integrity[1].toUpperCase(), checksumValue: Buffer.from(integrity[2], "base64").toString("hex") }],
  };
})];
const document = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: `freeplane-mcp-${packageMetadata.version}`,
  documentNamespace: `https://github.com/Hilbert-beinghappy/freeplane-mcp/spdx/${packageMetadata.version}/${createHash("sha256").update(JSON.stringify(packages)).digest("hex")}`,
  creationInfo: {
    created: new Date().toISOString(),
    creators: ["Tool: freeplane-mcp/scripts/generate_sbom.mjs"],
  },
  packages,
  relationships: packages.slice(1).map((dependency) => ({
    spdxElementId: "SPDXRef-Package-Freeplane-MCP",
    relationshipType: "DEPENDS_ON",
    relatedSpdxElement: dependency.SPDXID,
  })),
};
await writeFile(path.join(root, "qualification/sbom.spdx.json"), `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ packages: packages.length, version: packageMetadata.version })}\n`);
