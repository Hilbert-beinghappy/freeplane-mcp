import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  FileFallbackError,
  listConfiguredMaps,
  parseMmXml,
  readConfiguredMap,
  requireConfiguredMap,
  writeClosedMapText,
} from "./fileFallback.js";

const execFile = promisify(execFileCallback);

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

test("closed-file text writeback preserves every byte outside qualified TEXT values", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "freeplane-mcp-writeback-test-"));
  const mapPath = path.join(temporary, "fixture.mm");
  const backupRoot = path.join(temporary, "backups");
  const source = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n<!--keep--><map version="freeplane 1.13.3" xmlns:x="urn:test"><node ID="ROOT" TEXT="root" x:flag="keep"><x:unknown VALUE="untouched"/><node ID="CHILD" TEXT='old'/></node></map>\n`),
  ]);
  await Promise.all([writeFile(mapPath, source), mkdir(backupRoot, { mode: 0o700 })]);
  await execFile("/usr/bin/xattr", ["-w", "com.freeplane-mcp.test", "preserved", mapPath]);

  try {
    const config = { files: [mapPath], allowedRoots: [temporary] };
    const map = await readConfiguredMap(mapPath, config);
    const result = await writeClosedMapText(
      map,
      map.sha256,
      [{ nodeId: "CHILD", text: `new & 'quoted' <x>` }],
      config,
      backupRoot,
    );
    const expected = Buffer.from(source.toString("utf8").replace(
      "TEXT='old'",
      "TEXT='new &amp; &apos;quoted&apos; &lt;x&gt;'",
    ));
    assert.deepEqual(await readFile(mapPath), expected);
    assert.deepEqual(await readFile(path.join(result.backupDirectory, "original.mm")), source);
    assert.deepEqual(await readFile(path.join(result.backupDirectory, "candidate.mm")), expected);
    assert.equal((await stat(result.backupDirectory)).mode & 0o077, 0);
    assert.equal((await stat(path.join(result.backupDirectory, "manifest.json"))).mode & 0o077, 0);
    assert.equal((await execFile("/usr/bin/xattr", ["-p", "com.freeplane-mcp.test", mapPath])).stdout.trim(), "preserved");
    assert.equal((await readConfiguredMap(mapPath, config)).content.root.children[0]?.text, `new & 'quoted' <x>`);

    await assert.rejects(
      writeClosedMapText(map, map.sha256, [{ nodeId: "CHILD", text: "stale" }], config, backupRoot),
      (error: unknown) => error instanceof FileFallbackError && error.category === "FILE_CONFLICT",
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
