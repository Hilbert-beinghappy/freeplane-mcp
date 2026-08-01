#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import plistlib
import re
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET


PROJECT = Path(__file__).resolve().parents[1]


def discover_freeplane() -> Path:
    configured = os.environ.get("FREEPLANE_HOME") or os.environ.get("FREEPLANE_APP")
    if configured:
        return Path(configured).expanduser().resolve()
    result = subprocess.run(
        ["/usr/bin/mdfind", "kMDItemCFBundleIdentifier == 'org.freeplane.launcher'"],
        check=True,
        capture_output=True,
        text=True,
    )
    candidate = next((Path(line) for line in result.stdout.splitlines() if line.endswith(".app")), None)
    if candidate is None:
        raise RuntimeError("Freeplane.app was not found; set FREEPLANE_HOME")
    return candidate.resolve()


FREEPLANE_APP = discover_freeplane()
FREEPLANE = FREEPLANE_APP / "Contents"
APP = FREEPLANE / "app"
DEFAULT_OUTPUT_ROOT = Path(os.environ.get(
    "FREEPLANE_MCP_ANALYSIS_ROOT",
    PROJECT / "analysis-output",
)).expanduser().resolve()
PACKAGE_NAME = "Freeplane_MCP_GPTPro咨询包_20260801"
REAL_EXAMPLE_ROOT = Path(os.environ.get(
    "FREEPLANE_MCP_REAL_EXAMPLE_ROOT",
    DEFAULT_OUTPUT_ROOT / "研究全景图",
)).expanduser().resolve()

MENU_FILES = [
    "resources/xml/filemodemenu.xml",
    "resources/xml/mindmapmodemenu.xml",
    "resources/xml/stylemodemenu.xml",
    "resources/xml/codeexplorermodemenu.xml",
]

CAPABILITIES = [
    ("连接与状态", "应用版本、连接、活动地图、revision", "bridge", "v0.1", "required"),
    ("地图读取", "打开地图、完整树、局部树、未保存状态", "bridge|file", "v0.1", "required"),
    ("选择与焦点", "当前选择、活动节点、活动地图", "bridge", "v0.1", "required"),
    ("搜索", "文本、属性、标签和范围搜索", "script_api", "v0.1", "required"),
    ("变更日志", "revision之后的地图与选择变化", "bridge", "v0.1", "required"),
    ("地图生命周期", "创建、打开、保存、另存、关闭", "script_api|menu", "v0.2-v0.4", "required"),
    ("节点结构", "新增、修改、删除、移动、排序、父子关系", "script_api", "v0.2", "required"),
    ("节点内容", "正文、详情、备注、属性、标签、图标", "script_api", "v0.2", "required"),
    ("关系", "链接、连接线、局部链接、书签", "script_api", "v0.2-v0.3", "required"),
    ("样式与布局", "字体、颜色、形状、边、云、左右侧和子节点布局", "script_api", "v0.2-v0.3", "required"),
    ("高级结构", "克隆、摘要节点、自由节点、折叠", "script_api|menu", "v0.3", "required"),
    ("过滤与条件样式", "筛选、查找、条件样式", "script_api|menu", "v0.3", "required"),
    ("计算与时间", "公式、日期、提醒", "script_api|menu", "v0.3", "required"),
    ("展示", "演示、打印预览、导航", "menu|gui", "v0.4-v0.5", "goal_level"),
    ("导入导出", "模板、导入、PNG/SVG/PDF/HTML等实际格式", "script_api|menu", "v0.4", "required"),
    ("保护", "地图/节点保护与加密", "menu|gui", "v0.4-v0.5", "confirmation_required"),
    ("设置与偏好", "高价值设置目标", "menu|gui", "v0.5", "goal_level"),
    ("第三方插件", "非Freeplane 1.13.3内置插件", "unsupported", "out_of_scope", "excluded"),
]


def run_text(*args: str) -> str:
    return subprocess.run(args, check=True, text=True, capture_output=True).stdout.strip()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def is_metadata_noise(path: Path) -> bool:
    return any(part == ".DS_Store" or part.startswith("._") or part == "__MACOSX" for part in path.parts)


def parse_menu_entries() -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []

    def visit(element: ET.Element, source: str, ancestors: list[str]) -> None:
        name = element.attrib.get("name", "")
        current = ancestors + ([name] if name else [])
        if element.tag == "Entry" and name:
            lower = name.lower()
            if lower.endswith("action") or "action." in lower:
                kind = "action"
            elif element.attrib.get("builder"):
                kind = "builder_or_container"
            else:
                kind = "named_entry"
            rows.append({
                "source": source,
                "name": name,
                "kind": kind,
                "builder": element.attrib.get("builder", ""),
                "plugin": element.attrib.get("plugin", ""),
                "used_by": element.attrib.get("usedBy", ""),
                "accelerator": element.attrib.get("accelerator", ""),
                "menu_path": " > ".join(current),
                "automation_status": "requires_runtime_validation",
            })
        for child in element:
            visit(child, source, current)

    for relative in MENU_FILES:
        path = APP / relative
        visit(ET.parse(path).getroot(), relative, [])
    return rows


def api_types() -> list[dict[str, str]]:
    root = APP / "doc/api/org/freeplane/api"
    rows = []
    for path in sorted(root.glob("*.html")):
        name = path.stem
        if name.startswith("package-"):
            continue
        rows.append({
            "type": name,
            "relative_javadoc": f"doc/api/org/freeplane/api/{path.name}",
            "status": "installed_public_javadoc",
        })
    return rows


def user_guide_categories() -> list[str]:
    path = APP / "doc/freeplaneUserGuide.mm"
    root = ET.parse(path).getroot()
    map_root = root.find("./node")
    if map_root is None:
        return []
    return [child.attrib.get("TEXT", "") for child in map_root.findall("node") if child.attrib.get("TEXT")]


def write_csv(path: Path, rows: list[dict[str, str]], headers: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=headers)
        writer.writeheader()
        writer.writerows(rows)


def build_environment() -> dict:
    with (FREEPLANE / "Info.plist").open("rb") as handle:
        app_info = plistlib.load(handle)
    java_line = subprocess.run(
        [str(FREEPLANE / "runtime/Contents/Home/bin/java"), "-version"],
        text=True, capture_output=True, check=True,
    ).stderr.splitlines()[0]
    return {
        "generated_at": "2026-08-01",
        "architecture": run_text("uname", "-m"),
        "macos_version": run_text("sw_vers", "-productVersion"),
        "freeplane_version": app_info.get("CFBundleShortVersionString"),
        "freeplane_install": str(FREEPLANE_APP),
        "freeplane_java": java_line,
        "node": run_text("node", "--version"),
        "npm": run_text("npm", "--version"),
        "mcp_transport": "local_stdio_only",
        "repository_location": "external_ExFAT_project_volume",
        "development_volume": "ExFAT_repository_with_local_APFS_dependency_and_test_cache",
    }


def copy_consultation_docs(destination: Path) -> None:
    for path in sorted((PROJECT / "consultation").glob("*.md")):
        shutil.copy2(path, destination / path.name)


def build_real_example(destination: Path) -> dict:
    canvas_source = REAL_EXAMPLE_ROOT / "移动App监管研究全景图.canvas"
    png_source = REAL_EXAMPLE_ROOT / "移动App监管研究全景图_高清渲染.png"
    if not canvas_source.exists() or not png_source.exists():
        raise FileNotFoundError("Real example canvas or rendered PNG is missing")
    example_dir = destination / "real_example"
    example_dir.mkdir()
    shutil.copy2(canvas_source, example_dir / canvas_source.name)
    shutil.copy2(png_source, example_dir / png_source.name)
    canvas = json.loads(canvas_source.read_text(encoding="utf-8"))
    summary = {
        "source_type": "redacted JSON Canvas structure",
        "nodes": len(canvas.get("nodes", [])),
        "edges": len(canvas.get("edges", [])),
        "groups": [node.get("label") for node in canvas.get("nodes", []) if node.get("type") == "group"],
        "text_nodes": [
            {"id": node.get("id"), "text": node.get("text", "")}
            for node in canvas.get("nodes", []) if node.get("type") == "text"
        ],
        "privacy_note": "Contains derived research-map claims only; no raw regulatory rows, paper files, credentials, or local paths.",
    }
    (example_dir / "研究全景图_结构摘要.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return summary


def privacy_scan(root: Path) -> list[dict[str, str]]:
    forbidden = [
        re.compile(r"/Users/[^/\s]+"),
        re.compile(r"/Volumes/[^/\s]+"),
        re.compile(r"(?i)(api[_-]?key|access[_-]?token|password)\s*[:=]\s*[^\s]+"),
        re.compile(r"secrets\.properties"),
    ]
    findings = []
    for path in sorted(root.rglob("*")):
        if is_metadata_noise(path.relative_to(root)) or not path.is_file() or path.suffix.lower() in {".png", ".jpg", ".jpeg"}:
            continue
        text = path.read_text(encoding="utf-8-sig", errors="replace")
        for pattern in forbidden:
            if pattern.search(text):
                findings.append({"file": path.relative_to(root).as_posix(), "pattern": pattern.pattern})
    return findings


def write_manifest(root: Path) -> list[dict[str, object]]:
    entries = []
    for path in sorted(root.rglob("*")):
        if path.is_file() and path.name != "MANIFEST.sha256" and not is_metadata_noise(path.relative_to(root)):
            entries.append({
                "path": path.relative_to(root).as_posix(),
                "bytes": path.stat().st_size,
                "sha256": sha256(path),
            })
    (root / "MANIFEST.sha256").write_text(
        "".join(f"{entry['sha256']}  {entry['path']}\n" for entry in entries), encoding="utf-8"
    )
    return entries


def create_zip(root: Path, destination: Path) -> None:
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(root.rglob("*")):
            if path.is_file() and not is_metadata_noise(path.relative_to(root)):
                archive.write(path, f"{root.name}/{path.relative_to(root).as_posix()}")
        bad = archive.testzip()
        if bad:
            raise RuntimeError(f"ZIP CRC failed for {bad}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-root", type=Path, default=DEFAULT_OUTPUT_ROOT)
    args = parser.parse_args()
    output_root = args.output_root.resolve()
    final_dir = output_root / PACKAGE_NAME
    final_zip = output_root / f"{PACKAGE_NAME}.zip"
    if final_dir.exists() or final_zip.exists():
        raise FileExistsError(f"Refusing to overwrite existing deliverable: {final_dir} or {final_zip}")
    if not FREEPLANE.exists():
        raise FileNotFoundError("Freeplane 1.13.3 is not installed in /Applications")

    output_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="freeplane-mcp-package-", dir=output_root) as temp:
        build = Path(temp) / PACKAGE_NAME
        build.mkdir()
        copy_consultation_docs(build)

        inventory = build / "inventory"
        inventory.mkdir()
        menu_rows = parse_menu_entries()
        api_rows = api_types()
        write_csv(
            inventory / "freeplane_menu_entries.csv", menu_rows,
            ["source", "name", "kind", "builder", "plugin", "used_by", "accelerator", "menu_path", "automation_status"],
        )
        write_csv(inventory / "freeplane_api_types.csv", api_rows, ["type", "relative_javadoc", "status"])
        capability_rows = [
            {"goal": a, "examples": b, "preferred_route": c, "target_version": d, "scope": e}
            for a, b, c, d, e in CAPABILITIES
        ]
        write_csv(
            inventory / "goal_capability_matrix.csv", capability_rows,
            ["goal", "examples", "preferred_route", "target_version", "scope"],
        )
        inventory_summary = {
            "menu_entry_rows": len(menu_rows),
            "unique_menu_names": len({row["name"] for row in menu_rows}),
            "action_rows": sum(row["kind"] == "action" for row in menu_rows),
            "unique_action_names": len({row["name"] for row in menu_rows if row["kind"] == "action"}),
            "installed_public_api_types": len(api_rows),
            "user_guide_categories": user_guide_categories(),
            "warning": "Inventory presence is not runtime automation proof; each route requires validation.",
        }
        (inventory / "inventory_summary.json").write_text(
            json.dumps(inventory_summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        (inventory / "environment.json").write_text(
            json.dumps(build_environment(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        real_summary = build_real_example(build)

        privacy_findings = privacy_scan(build)
        if privacy_findings:
            raise RuntimeError(f"Privacy scan failed: {privacy_findings}")
        audit = {
            "status": "PASS",
            "package": PACKAGE_NAME,
            "manifest_policy": "Every package file except MANIFEST.sha256 is hashed after this audit is written.",
            "privacy_findings": privacy_findings,
            "inventory": inventory_summary,
            "real_example": {"nodes": real_summary["nodes"], "edges": real_summary["edges"]},
            "excluded": ["raw regulatory data", "paper PDFs/DOCX", "credentials", "private MCP configuration"],
        }
        (build / "package_audit.json").write_text(
            json.dumps(audit, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        write_manifest(build)
        os.replace(build, final_dir)

    create_zip(final_dir, final_zip)
    print(json.dumps({
        "directory": str(final_dir),
        "zip": str(final_zip),
        "zip_bytes": final_zip.stat().st_size,
        "inventory": json.loads((final_dir / "inventory/inventory_summary.json").read_text(encoding="utf-8")),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
