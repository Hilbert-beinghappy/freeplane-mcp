import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_XML_DEPTH = 256;
const MAX_NODES = 50_000;
const MAX_ATTRIBUTES_PER_ELEMENT = 128;
const MAX_TOTAL_ATTRIBUTES = 500_000;
const MAX_TEXT_CHARS = 1_000_000;
const MAX_TAG_CHARS = 2_000_000;

export interface FileFallbackConfig {
  files: string[];
  allowedRoots: string[];
}

export interface MmNode {
  id: string;
  text: string;
  details: string | null;
  note: string | null;
  attributes: Array<{ name: string; value: string }>;
  tags: string[];
  icons: string[];
  link: string | null;
  style: { name: string | null; background_color: string | null; text_color: string | null };
  folded: boolean;
  connectors: Array<{
    target_id: string;
    shape: string | null;
    color: string | null;
    width: string | null;
    start_arrow: string | null;
    end_arrow: string | null;
  }>;
  timestamps: { created: string | null; modified: string | null };
  encrypted: boolean;
  children: MmNode[];
}

export interface ParsedMmMap {
  schema_version: 1;
  map_id: string;
  name: string;
  background_color: string | null;
  root: MmNode;
}

export interface FileMap {
  mapId: string;
  canonicalPath: string;
  sha256: string;
  size: number;
  mtime: string;
  nodeCount: number;
  content: ParsedMmMap;
}

export class FileFallbackError extends Error {
  constructor(
    readonly category: "PATH_DENIED" | "XML_UNSAFE" | "XML_INVALID" | "LIMIT_EXCEEDED" | "MAP_NOT_FOUND"
      | "FILE_CONFLICT" | "ROUNDTRIP_UNSAFE" | "RECOVERY_REQUIRED",
    message: string,
  ) {
    super(message);
  }
}

function stringArray(value: string | undefined, name: string): string[] {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new FileFallbackError("PATH_DENIED", `${name} must be a JSON string array`);
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new FileFallbackError("PATH_DENIED", `${name} must be a JSON string array`);
  }
  return [...new Set(parsed)];
}

export function fileFallbackConfig(env: NodeJS.ProcessEnv = process.env): FileFallbackConfig {
  const files = stringArray(env.FREEPLANE_MCP_FILES, "FREEPLANE_MCP_FILES");
  const configuredRoots = stringArray(env.FREEPLANE_MCP_ALLOWED_ROOTS, "FREEPLANE_MCP_ALLOWED_ROOTS");
  return {
    files,
    allowedRoots: configuredRoots.length > 0 ? configuredRoots : files.map((file) => path.dirname(file)),
  };
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function mapId(canonicalPath: string): string {
  return `file:${digest(canonicalPath)}`;
}

export function underRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function secureRead(candidate: string, config: FileFallbackConfig) {
  const absolute = path.resolve(candidate);
  const entry = await lstat(absolute).catch(() => null);
  if (!entry || !entry.isFile() || entry.isSymbolicLink()) {
    throw new FileFallbackError("PATH_DENIED", "Configured map must be an existing regular non-symlink file");
  }
  if (path.extname(absolute).toLowerCase() !== ".mm") {
    throw new FileFallbackError("PATH_DENIED", "File fallback accepts only .mm files");
  }

  const [canonicalPath, roots] = await Promise.all([
    realpath(absolute),
    Promise.all(config.allowedRoots.map(async (root) => realpath(path.resolve(root)))),
  ]);
  if (roots.length === 0 || !roots.some((root) => underRoot(canonicalPath, root))) {
    throw new FileFallbackError("PATH_DENIED", "Configured map is outside the allowlisted roots");
  }

  const handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!handle) throw new FileFallbackError("PATH_DENIED", "Map could not be opened without following symlinks");
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new FileFallbackError("PATH_DENIED", "Map is not a regular file");
    if (before.size > MAX_FILE_BYTES) {
      throw new FileFallbackError("LIMIT_EXCEEDED", `Map exceeds ${MAX_FILE_BYTES} bytes`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || bytes.length !== after.size
    ) {
      throw new FileFallbackError("PATH_DENIED", "Map changed while it was being read");
    }
    return { canonicalPath, bytes, stats: after };
  } finally {
    await handle.close();
  }
}

function decodeEntities(value: string): string {
  const pattern = /&(?:#(\d+)|#x([0-9A-Fa-f]+)|amp|lt|gt|quot|apos);/g;
  if (value.replace(pattern, "").includes("&")) {
    throw new FileFallbackError("XML_UNSAFE", "Unknown or unterminated XML entity");
  }
  return value.replace(pattern, (entity, decimal, hex) => {
    if (decimal !== undefined || hex !== undefined) {
      const codePoint = Number.parseInt(decimal ?? hex, decimal === undefined ? 16 : 10);
      if (
        codePoint !== 0x9
        && codePoint !== 0xa
        && codePoint !== 0xd
        && (codePoint < 0x20 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff))
      ) {
        throw new FileFallbackError("XML_INVALID", "Numeric entity is not a valid XML character");
      }
      return String.fromCodePoint(codePoint);
    }
    return ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" } as const)[
      entity as "&amp;" | "&lt;" | "&gt;" | "&quot;" | "&apos;"
    ];
  });
}

function parseStartTag(raw: string): { name: string; attributes: Map<string, string>; selfClosing: boolean } {
  let body = raw.slice(1, -1);
  if (!body || /^\s/u.test(body)) throw new FileFallbackError("XML_INVALID", "Malformed XML start tag");
  body = body.trimEnd();
  const selfClosing = body.endsWith("/");
  if (selfClosing) body = body.slice(0, -1).trimEnd();
  let index = 0;
  const nameMatch = /^[A-Za-z_:][A-Za-z0-9_.:-]*/.exec(body);
  if (!nameMatch) throw new FileFallbackError("XML_INVALID", "Malformed XML element name");
  const name = nameMatch[0];
  index = name.length;
  const attributes = new Map<string, string>();
  while (index < body.length) {
    while (/\s/u.test(body[index] ?? "")) index++;
    if (index === body.length) break;
    const attributeMatch = /^[A-Za-z_:][A-Za-z0-9_.:-]*/.exec(body.slice(index));
    if (!attributeMatch) throw new FileFallbackError("XML_INVALID", `Malformed attribute in <${name}>`);
    const attributeName = attributeMatch[0];
    index += attributeName.length;
    while (/\s/u.test(body[index] ?? "")) index++;
    if (body[index++] !== "=") throw new FileFallbackError("XML_INVALID", `Attribute ${attributeName} has no value`);
    while (/\s/u.test(body[index] ?? "")) index++;
    const quote = body[index++];
    if (quote !== '"' && quote !== "'") {
      throw new FileFallbackError("XML_INVALID", `Attribute ${attributeName} must be quoted`);
    }
    const end = body.indexOf(quote, index);
    if (end === -1) throw new FileFallbackError("XML_INVALID", `Attribute ${attributeName} is unterminated`);
    if (end - index > MAX_TEXT_CHARS) throw new FileFallbackError("LIMIT_EXCEEDED", "XML attribute value is too long");
    if (attributes.has(attributeName)) {
      throw new FileFallbackError("XML_INVALID", `Duplicate XML attribute ${attributeName}`);
    }
    attributes.set(attributeName, decodeEntities(body.slice(index, end)));
    if (attributes.size > MAX_ATTRIBUTES_PER_ELEMENT) {
      throw new FileFallbackError("LIMIT_EXCEEDED", "XML element has too many attributes");
    }
    index = end + 1;
  }
  return { name, attributes, selfClosing };
}

function tagEnd(xml: string, start: number): number {
  let quote: string | null = null;
  const maximum = Math.min(xml.length, start + MAX_TAG_CHARS);
  for (let index = start + 1; index < maximum; index++) {
    const character = xml[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index + 1;
    }
  }
  throw new FileFallbackError("XML_INVALID", "XML tag is unterminated or too large");
}

function newNode(attributes: Map<string, string>, ordinal: number): MmNode {
  return {
    id: attributes.get("ID") ?? `FILE_NODE_${ordinal}`,
    text: attributes.get("TEXT") ?? "",
    details: null,
    note: null,
    attributes: [],
    tags: [],
    icons: [],
    link: attributes.get("LINK") ?? null,
    style: {
      name: attributes.get("STYLE_REF") ?? attributes.get("LOCALIZED_STYLE_REF") ?? null,
      background_color: attributes.get("BACKGROUND_COLOR") ?? null,
      text_color: attributes.get("COLOR") ?? null,
    },
    folded: attributes.get("FOLDED")?.toLowerCase() === "true",
    connectors: [],
    timestamps: {
      created: attributes.get("CREATED") ?? null,
      modified: attributes.get("MODIFIED") ?? null,
    },
    encrypted: attributes.has("ENCRYPTED_CONTENT"),
    children: [],
  };
}

interface ElementFrame {
  name: string;
  pushedNode: boolean;
  richType: "DETAILS" | "NOTE" | null;
  richText: string[];
}

export function parseMmXml(bytes: Buffer, identity = "file:unresolved", name = "map.mm"): ParsedMmMap {
  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new FileFallbackError("XML_INVALID", "Map is not valid UTF-8");
  }
  if (xml.charCodeAt(0) === 0xfeff) xml = xml.slice(1);
  for (const character of xml) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint !== 0x9
      && codePoint !== 0xa
      && codePoint !== 0xd
      && (codePoint < 0x20 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff))
    ) {
      throw new FileFallbackError("XML_INVALID", "Map contains invalid XML control characters");
    }
  }
  const declaration = /^\s*<\?xml\s+([^?]+)\?>/i.exec(xml);
  if (declaration?.[1] && /encoding\s*=\s*['"](?!utf-?8['"])/i.test(declaration[1])) {
    throw new FileFallbackError("XML_INVALID", "Only UTF-8 .mm files are supported");
  }

  const elements: ElementFrame[] = [];
  const nodes: MmNode[] = [];
  let root: MmNode | null = null;
  let mapSeen = false;
  let backgroundColor: string | null = null;
  let totalAttributes = 0;
  let nodeCount = 0;
  let index = 0;

  const finish = (frame: ElementFrame) => {
    if (frame.richType) {
      const node = nodes.at(-1);
      if (!node) throw new FileFallbackError("XML_INVALID", "richcontent appears outside a node");
      const text = frame.richText.join(" ").replace(/\s+/g, " ").trim();
      if (text.length > MAX_TEXT_CHARS) throw new FileFallbackError("LIMIT_EXCEEDED", "Rich text is too long");
      if (frame.richType === "DETAILS") node.details = text;
      else node.note = text;
    }
    if (frame.pushedNode) nodes.pop();
  };

  while (index < xml.length) {
    const openIndex = xml.indexOf("<", index);
    const textEnd = openIndex === -1 ? xml.length : openIndex;
    if (textEnd > index) {
      const text = xml.slice(index, textEnd);
      if (text.length > MAX_TEXT_CHARS) throw new FileFallbackError("LIMIT_EXCEEDED", "XML text is too long");
      const rich = [...elements].reverse().find((frame) => frame.richType);
      if (rich) rich.richText.push(decodeEntities(text));
      else if (elements.length === 0 && text.trim()) throw new FileFallbackError("XML_INVALID", "Text appears outside the map root");
    }
    if (openIndex === -1) break;

    if (xml.startsWith("<!--", openIndex)) {
      const end = xml.indexOf("-->", openIndex + 4);
      if (end === -1 || xml.slice(openIndex + 4, end).includes("--")) {
        throw new FileFallbackError("XML_INVALID", "Malformed XML comment");
      }
      index = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", openIndex)) {
      const end = xml.indexOf("]]>", openIndex + 9);
      if (end === -1) throw new FileFallbackError("XML_INVALID", "Unterminated CDATA section");
      const content = xml.slice(openIndex + 9, end);
      if (content.length > MAX_TEXT_CHARS) throw new FileFallbackError("LIMIT_EXCEEDED", "CDATA is too long");
      if (elements.length === 0) throw new FileFallbackError("XML_INVALID", "CDATA appears outside the map root");
      const rich = [...elements].reverse().find((frame) => frame.richType);
      if (rich) rich.richText.push(content);
      index = end + 3;
      continue;
    }
    if (xml.startsWith("<?", openIndex)) {
      const end = xml.indexOf("?>", openIndex + 2);
      if (end === -1) throw new FileFallbackError("XML_INVALID", "Unterminated processing instruction");
      if (!/^<\?xml\s/i.test(xml.slice(openIndex, end + 2)) || openIndex !== xml.search(/\S/u)) {
        throw new FileFallbackError("XML_UNSAFE", "Processing instructions are not allowed");
      }
      index = end + 2;
      continue;
    }
    if (xml.startsWith("<!", openIndex)) {
      throw new FileFallbackError("XML_UNSAFE", "DTD, entity declarations, and XML includes are not allowed");
    }

    const end = tagEnd(xml, openIndex);
    const raw = xml.slice(openIndex, end);
    if (raw.startsWith("</")) {
      const body = raw.slice(2, -1);
      if (/^\s/u.test(body)) throw new FileFallbackError("XML_INVALID", "Malformed closing element");
      const name = body.trimEnd();
      if (!/^[A-Za-z_:][A-Za-z0-9_.:-]*$/.test(name)) {
        throw new FileFallbackError("XML_INVALID", "Malformed closing element");
      }
      const frame = elements.pop();
      if (!frame || frame.name !== name) throw new FileFallbackError("XML_INVALID", `Mismatched closing element ${name}`);
      finish(frame);
      index = end;
      continue;
    }

    const parsed = parseStartTag(raw);
    totalAttributes += parsed.attributes.size;
    if (totalAttributes > MAX_TOTAL_ATTRIBUTES) {
      throw new FileFallbackError("LIMIT_EXCEEDED", "XML has too many attributes");
    }
    if (elements.length >= MAX_XML_DEPTH) throw new FileFallbackError("LIMIT_EXCEEDED", "XML is too deep");
    const lowerName = parsed.name.toLowerCase();
    const parentName = elements.at(-1)?.name.toLowerCase() ?? null;
    if (elements.length === 0 && (lowerName !== "map" || mapSeen)) {
      throw new FileFallbackError("XML_INVALID", "Map must be the only document root");
    }
    if (lowerName === "xi:include" || lowerName.endsWith(":include") || [...parsed.attributes.values()].some(
      (value) => value === "http://www.w3.org/2001/XInclude",
    )) {
      throw new FileFallbackError("XML_UNSAFE", "XInclude is not allowed");
    }

    let pushedNode = false;
    let richType: "DETAILS" | "NOTE" | null = null;
    if (lowerName === "map") {
      if (mapSeen || elements.length !== 0) throw new FileFallbackError("XML_INVALID", "Map must have one document root");
      mapSeen = true;
      backgroundColor = parsed.attributes.get("BACKGROUND_COLOR") ?? null;
    } else if (lowerName === "node") {
      if (!mapSeen) throw new FileFallbackError("XML_INVALID", "Node appears before map root");
      if (parentName !== "map" && parentName !== "node") {
        throw new FileFallbackError("XML_INVALID", "Node appears outside the Freeplane node tree");
      }
      if (nodes.length + 1 > MAX_XML_DEPTH) throw new FileFallbackError("LIMIT_EXCEEDED", "Node tree is too deep");
      const node = newNode(parsed.attributes, ++nodeCount);
      if (nodeCount > MAX_NODES) throw new FileFallbackError("LIMIT_EXCEEDED", "Map has too many nodes");
      const parent = nodes.at(-1);
      if (parent) parent.children.push(node);
      else if (root) throw new FileFallbackError("XML_INVALID", "Map has multiple root nodes");
      else root = node;
      nodes.push(node);
      pushedNode = true;
    } else if (lowerName === "attribute" && parentName === "node") {
      const node = nodes.at(-1);
      if (!node) throw new FileFallbackError("XML_INVALID", "Attribute appears outside a node");
      node.attributes.push({
        name: parsed.attributes.get("NAME") ?? "",
        value: parsed.attributes.get("VALUE") ?? "",
      });
    } else if (lowerName === "icon" && parentName === "node") {
      const node = nodes.at(-1);
      const icon = parsed.attributes.get("BUILTIN");
      if (node && icon) node.icons.push(icon);
    } else if (lowerName === "tag" && parentName === "node") {
      const node = nodes.at(-1);
      const tag = parsed.attributes.get("NAME") ?? parsed.attributes.get("VALUE");
      if (node && tag) node.tags.push(tag);
    } else if (lowerName === "arrowlink" && parentName === "node") {
      const node = nodes.at(-1);
      const target = parsed.attributes.get("DESTINATION");
      if (node && target) {
        node.connectors.push({
          target_id: target,
          shape: parsed.attributes.get("SHAPE") ?? null,
          color: parsed.attributes.get("COLOR") ?? null,
          width: parsed.attributes.get("WIDTH") ?? null,
          start_arrow: parsed.attributes.get("STARTARROW") ?? null,
          end_arrow: parsed.attributes.get("ENDARROW") ?? null,
        });
      }
    } else if (lowerName === "richcontent" && parentName === "node") {
      const type = parsed.attributes.get("TYPE")?.toUpperCase();
      if (type === "DETAILS" || type === "NOTE") richType = type;
    } else if (lowerName === "hook" && parentName === "node" && /encrypt/i.test(parsed.attributes.get("NAME") ?? "")) {
      const node = nodes.at(-1);
      if (node) node.encrypted = true;
    }

    const frame = { name: parsed.name, pushedNode, richType, richText: [] } satisfies ElementFrame;
    if (parsed.selfClosing) finish(frame);
    else elements.push(frame);
    index = end;
  }

  if (elements.length !== 0) throw new FileFallbackError("XML_INVALID", "XML document is incomplete");
  if (!mapSeen || !root) throw new FileFallbackError("XML_INVALID", "Map has no root node");
  return {
    schema_version: 1,
    map_id: identity,
    name,
    background_color: backgroundColor,
    root,
  };
}

function countNodes(root: MmNode): number {
  let count = 0;
  const pending = [root];
  while (pending.length) {
    const node = pending.pop();
    if (!node) continue;
    count++;
    pending.push(...node.children);
  }
  return count;
}

export async function readConfiguredMap(candidate: string, config: FileFallbackConfig): Promise<FileMap> {
  const { canonicalPath, bytes, stats } = await secureRead(candidate, config);
  const id = mapId(canonicalPath);
  const content = parseMmXml(bytes, id, path.basename(canonicalPath));
  return {
    mapId: id,
    canonicalPath,
    sha256: digest(bytes),
    size: stats.size,
    mtime: stats.mtime.toISOString(),
    nodeCount: countNodes(content.root),
    content,
  };
}

export async function listConfiguredMaps(config: FileFallbackConfig): Promise<FileMap[]> {
  const maps = await Promise.all(config.files.map((file) => readConfiguredMap(file, config)));
  const unique = new Map(maps.map((map) => [map.mapId, map]));
  return [...unique.values()].sort((left, right) => left.canonicalPath.localeCompare(right.canonicalPath));
}

export async function requireConfiguredMap(mapIdentity: string, config: FileFallbackConfig): Promise<FileMap> {
  const maps = await listConfiguredMaps(config);
  const found = maps.find((map) => map.mapId === mapIdentity);
  if (!found) throw new FileFallbackError("MAP_NOT_FOUND", `Configured file map is unavailable: ${mapIdentity}`);
  return found;
}

export interface FileTextUpdate {
  nodeId: string;
  text: string;
}

interface TextSpan {
  nodeId: string;
  start: number;
  end: number;
  quote: string;
}

function xmlString(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new FileFallbackError("XML_INVALID", "Map is not valid UTF-8");
  }
}

function textSpans(xml: string, nodeIds: Set<string>): TextSpan[] {
  const found: TextSpan[] = [];
  let index = 0;
  while (index < xml.length) {
    const start = xml.indexOf("<", index);
    if (start === -1) break;
    if (xml.startsWith("<!--", start)) {
      const end = xml.indexOf("-->", start + 4);
      if (end === -1) throw new FileFallbackError("XML_INVALID", "Malformed XML comment");
      index = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", start)) {
      const end = xml.indexOf("]]>", start + 9);
      if (end === -1) throw new FileFallbackError("XML_INVALID", "Unterminated CDATA section");
      index = end + 3;
      continue;
    }
    if (xml.startsWith("<?", start)) {
      const end = xml.indexOf("?>", start + 2);
      if (end === -1) throw new FileFallbackError("XML_INVALID", "Unterminated processing instruction");
      index = end + 2;
      continue;
    }
    const end = tagEnd(xml, start);
    const raw = xml.slice(start, end);
    if (!raw.startsWith("</") && !raw.startsWith("<!")) {
      const parsed = parseStartTag(raw);
      if (parsed.name.toLowerCase() === "node") {
        const nodeId = parsed.attributes.get("ID");
        if (nodeId && nodeIds.has(nodeId)) {
          const text = /(\sTEXT\s*=\s*)(["'])([\s\S]*?)\2/u.exec(raw);
          if (!text || text.index === undefined) {
            throw new FileFallbackError("ROUNDTRIP_UNSAFE", `Node ${nodeId} has no lexical TEXT attribute`);
          }
          const prefix = text[1]!;
          const quote = text[2]!;
          const value = text[3]!;
          const valueOffset = text.index + prefix.length + quote.length;
          found.push({
            nodeId,
            start: start + valueOffset,
            end: start + valueOffset + value.length,
            quote,
          });
        }
      }
    }
    index = end;
  }
  for (const nodeId of nodeIds) {
    if (found.filter((span) => span.nodeId === nodeId).length !== 1) {
      throw new FileFallbackError("ROUNDTRIP_UNSAFE", `Node ${nodeId} is missing or duplicated in lexical XML`);
    }
  }
  return found;
}

function escapeAttribute(value: string, quote: string): string {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code !== 0x9 && code !== 0xa && code !== 0xd
        && (code < 0x20 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))) {
      throw new FileFallbackError("XML_INVALID", "Node text contains an invalid XML character");
    }
  }
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll(quote, quote === '"' ? "&quot;" : "&apos;");
}

function replaceSpans(xml: string, spans: TextSpan[], values: Map<string, string>): string {
  let value = xml;
  for (const span of [...spans].sort((left, right) => right.start - left.start)) {
    const replacement = values.get(span.nodeId);
    if (replacement === undefined) throw new FileFallbackError("ROUNDTRIP_UNSAFE", "Text patch value is unavailable");
    value = `${value.slice(0, span.start)}${escapeAttribute(replacement, span.quote)}${value.slice(span.end)}`;
  }
  return value;
}

function maskTexts(xml: string, nodeIds: Set<string>): string {
  const marker = new Map([...nodeIds].map((nodeId) => [nodeId, `__FREEPLANE_MCP_TEXT_${nodeId}__`]));
  return replaceSpans(xml, textSpans(xml, nodeIds), marker);
}

function findNode(root: MmNode, nodeId: string): MmNode | null {
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) continue;
    if (node.id === nodeId) return node;
    pending.push(...node.children);
  }
  return null;
}

async function writeSynced(target: string, bytes: Buffer | string) {
  const handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeClosedMapText(
  map: FileMap,
  expectedSha256: string,
  updates: FileTextUpdate[],
  config: FileFallbackConfig,
  backupRoot: string,
) {
  if (updates.length === 0 || updates.length > 100 || new Set(updates.map((update) => update.nodeId)).size !== updates.length) {
    throw new FileFallbackError("ROUNDTRIP_UNSAFE", "File text updates require 1-100 distinct nodes");
  }
  const before = await secureRead(map.canonicalPath, config);
  const beforeSha256 = digest(before.bytes);
  if (beforeSha256 !== expectedSha256 || beforeSha256 !== map.sha256) {
    throw new FileFallbackError("FILE_CONFLICT", "File changed after its expected revision was read");
  }
  const originalXml = xmlString(before.bytes);
  const nodeIds = new Set(updates.map((update) => update.nodeId));
  const parsedBefore = parseMmXml(before.bytes, map.mapId, map.content.name);
  for (const update of updates) {
    const node = findNode(parsedBefore.root, update.nodeId);
    if (!node) throw new FileFallbackError("MAP_NOT_FOUND", `Node is unavailable: ${update.nodeId}`);
    if (node.encrypted || node.text.startsWith("=")) {
      throw new FileFallbackError("ROUNDTRIP_UNSAFE", "Encrypted and formula nodes are not eligible for file writeback");
    }
  }
  const values = new Map(updates.map((update) => [update.nodeId, update.text]));
  const candidateXml = replaceSpans(originalXml, textSpans(originalXml, nodeIds), values);
  if (maskTexts(originalXml, nodeIds) !== maskTexts(candidateXml, nodeIds)) {
    throw new FileFallbackError("ROUNDTRIP_UNSAFE", "File writeback changed bytes outside target TEXT values");
  }
  const candidateBytes = Buffer.from(candidateXml, "utf8");
  const parsedAfter = parseMmXml(candidateBytes, map.mapId, map.content.name);
  for (const update of updates) {
    if (findNode(parsedAfter.root, update.nodeId)?.text !== update.text) {
      throw new FileFallbackError("ROUNDTRIP_UNSAFE", `Node ${update.nodeId} failed semantic readback`);
    }
  }
  if (countNodes(parsedAfter.root) !== map.nodeCount) {
    throw new FileFallbackError("ROUNDTRIP_UNSAFE", "File writeback changed the node count");
  }

  const transactionId = randomUUID();
  const backupDirectory = path.join(backupRoot, transactionId);
  await mkdir(backupDirectory, { recursive: false, mode: 0o700 });
  await chmod(backupDirectory, 0o700);
  const manifest = {
    schema_version: 1,
    transaction_id: transactionId,
    target_sha256_before: beforeSha256,
    candidate_sha256: digest(candidateBytes),
    node_ids: updates.map((update) => update.nodeId),
    status: "prepared",
  };
  await Promise.all([
    writeSynced(path.join(backupDirectory, "original.mm"), before.bytes),
    writeSynced(path.join(backupDirectory, "candidate.mm"), candidateBytes),
    writeSynced(path.join(backupDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`),
  ]);
  const backupDirectoryHandle = await open(backupDirectory, constants.O_RDONLY);
  try { await backupDirectoryHandle.sync(); } finally { await backupDirectoryHandle.close(); }
  const backupRootHandle = await open(backupRoot, constants.O_RDONLY);
  try { await backupRootHandle.sync(); } finally { await backupRootHandle.close(); }

  const temporary = path.join(path.dirname(map.canonicalPath), `.${path.basename(map.canonicalPath)}.${transactionId}.tmp`);
  try {
    // Native clonefile preserves macOS metadata and xattrs; Node's force-clone flag is ENOSYS on macOS.
    await execFile("/bin/cp", ["-c", "-p", "-n", map.canonicalPath, temporary], {
      timeout: 10_000,
      windowsHide: true,
    });
    const temporaryHandle = await open(temporary, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      const cloned = await temporaryHandle.readFile();
      if (digest(cloned) !== beforeSha256) {
        throw new FileFallbackError("FILE_CONFLICT", "Cloned file diverged from the planned revision");
      }
      await temporaryHandle.truncate(0);
      await temporaryHandle.write(candidateBytes, 0, candidateBytes.length, 0);
      await temporaryHandle.sync();
    } finally {
      await temporaryHandle.close();
    }
    const current = await secureRead(map.canonicalPath, config);
    if (digest(current.bytes) !== beforeSha256) {
      throw new FileFallbackError("FILE_CONFLICT", "File changed before atomic replacement");
    }
    await rename(temporary, map.canonicalPath);
    const parent = await open(path.dirname(map.canonicalPath), constants.O_RDONLY);
    try { await parent.sync(); } finally { await parent.close(); }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    if (error instanceof FileFallbackError) throw error;
    throw new FileFallbackError("RECOVERY_REQUIRED", "Atomic APFS file replacement failed; backup evidence was retained");
  }

  const after = await secureRead(map.canonicalPath, config);
  const afterSha256 = digest(after.bytes);
  if (afterSha256 !== digest(candidateBytes)) {
    throw new FileFallbackError("RECOVERY_REQUIRED", "Replaced file hash diverged; backup evidence was retained");
  }
  return {
    transactionId,
    beforeSha256,
    afterSha256,
    backupDirectory,
    nodeCount: map.nodeCount,
  };
}
