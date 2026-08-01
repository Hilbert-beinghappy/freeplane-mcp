import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FileFallbackError,
  listConfiguredMaps,
  parseMmXml,
  requireConfiguredMap,
} from "./fileFallback.js";

const VALID_MAP = `<?xml version="1.0" encoding="UTF-8"?>
<map version="freeplane 1.13.3">
  <node ID="ROOT" TEXT="A &amp; B">
    <attribute NAME="same" VALUE="first"/>
    <attribute NAME="same" VALUE="second"/>
    <node ID="CHILD" TEXT="child"><richcontent TYPE="NOTE"><html><body>safe note</body></html></richcontent></node>
  </node>
</map>`;

test("bounded file parser preserves node order and duplicate Freeplane attributes", () => {
  const parsed = parseMmXml(Buffer.from(VALID_MAP), "file:test", "test.mm");
  assert.equal(parsed.root.text, "A & B");
  assert.deepEqual(parsed.root.attributes, [
    { name: "same", value: "first" },
    { name: "same", value: "second" },
  ]);
  assert.equal(parsed.root.children[0]?.note, "safe note");
});

test("file parser rejects active XML features and malformed content", () => {
  for (const source of [
    `<!DOCTYPE map [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><map><node TEXT="&xxe;"/></map>`,
    `<map xmlns:xi="http://www.w3.org/2001/XInclude"><node><xi:include href="file:///etc/passwd"/></node></map>`,
    `<map><node></map>`,
    `<map><node TEXT="&unknown;"/></map>`,
    `<map><node/></map><extra/>`,
    `<map><extension><node/></extension></map>`,
    `<![CDATA[outside]]><map><node/></map>`,
    `< map><node/></map>`,
    `<map><node/></ map>`,
  ]) {
    assert.throws(() => parseMmXml(Buffer.from(source)), FileFallbackError);
  }
});

test("file fallback exposes only configured regular maps inside allowlisted roots", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "freeplane-mcp-file-test-"));
  const allowed = path.join(temporary, "allowed");
  const outside = path.join(temporary, "outside");
  await Promise.all([mkdir(allowed), mkdir(outside)]);
  const mapPath = path.join(allowed, "fixture.mm");
  const outsidePath = path.join(outside, "outside.mm");
  const linkPath = path.join(allowed, "link.mm");
  await Promise.all([
    writeFile(mapPath, VALID_MAP),
    writeFile(outsidePath, VALID_MAP),
    symlink(mapPath, linkPath),
  ]);

  try {
    const config = { files: [mapPath], allowedRoots: [allowed] };
    const maps = await listConfiguredMaps(config);
    assert.equal(maps.length, 1);
    assert.match(maps[0]?.mapId ?? "", /^file:[a-f0-9]{64}$/);
    assert.equal((await requireConfiguredMap(maps[0]?.mapId ?? "", config)).sha256.length, 64);

    await assert.rejects(
      listConfiguredMaps({ files: [outsidePath], allowedRoots: [allowed] }),
      (error: unknown) => error instanceof FileFallbackError && error.category === "PATH_DENIED",
    );
    await assert.rejects(
      listConfiguredMaps({ files: [linkPath], allowedRoots: [allowed] }),
      (error: unknown) => error instanceof FileFallbackError && error.category === "PATH_DENIED",
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
