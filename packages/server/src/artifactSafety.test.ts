import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { BridgeClientError } from "./bridgeClient.js";
import { commitArtifact, prepareDestination, removeStaging, validateArtifact } from "./artifactSafety.js";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 13]),
  Buffer.from("IHDR"),
  Buffer.from([0, 0, 0, 2, 0, 0, 0, 3]),
]);

test("export artifacts are format-checked before atomic publication", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "freeplane-mcp-artifact-test-"));
  const backupRoot = path.join(temporary, "backups");
  await mkdir(backupRoot, { mode: 0o700 });
  const config = { files: [], allowedRoots: [temporary] };

  try {
    for (const [format, bytes, expected] of [
      ["png", PNG, { mime: "image/png", width: 2, height: 3 }],
      ["pdf", Buffer.from("%PDF-1.4\n1 0 obj<</Type /Page>>\nendobj\n%%EOF\n"), { mime: "application/pdf", pages: 1 }],
      ["svg", Buffer.from(`<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<!--generated--><svg xmlns="http://www.w3.org/2000/svg"></svg><!--end-->`), { mime: "image/svg+xml", root: "svg" }],
      ["html", Buffer.from("<!DOCTYPE html><html><body>safe</body></html>"), { mime: "text/html", root: "html" }],
    ] as const) {
      const target = path.join(temporary, `map.${format}`);
      const prepared = await prepareDestination(target, format, config);
      await writeFile(prepared.staging, bytes);
      const artifact = await commitArtifact(prepared, format, false, backupRoot);
      assert.equal(artifact.mime, expected.mime);
      for (const [key, value] of Object.entries(expected)) assert.equal(artifact[key as keyof typeof artifact], value);
      assert.deepEqual(await readFile(target), bytes);
    }

    const target = path.join(temporary, "map.svg");
    const replacement = Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"><path/></svg>");
    const overwrite = await prepareDestination(target, "svg", config);
    await writeFile(overwrite.staging, replacement);
    await assert.rejects(
      commitArtifact(overwrite, "svg", false, backupRoot),
      (error: unknown) => error instanceof BridgeClientError && error.category === "CONFIRMATION_REQUIRED",
    );
    await removeStaging(overwrite);

    for (const [name, value, format] of [
      ["active.svg", "<!DOCTYPE svg><svg></svg>", "svg"],
      ["active.html", "<html><script>alert(1)</script></html>", "html"],
      ["empty.pdf", "", "pdf"],
    ] as const) {
      const candidate = path.join(temporary, name);
      await writeFile(candidate, value);
      await assert.rejects(
        validateArtifact(candidate, format),
        (error: unknown) => error instanceof BridgeClientError && error.category === "POSTCONDITION_FAILED",
      );
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
