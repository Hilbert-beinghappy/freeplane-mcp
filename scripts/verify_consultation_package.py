#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import sys
import zipfile
from pathlib import Path


DEFAULT_ROOT = Path("/Volumes/huawei/项目实战/算法合规/分析结果")
NAME = "Freeplane_MCP_GPTPro咨询包_20260801"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else DEFAULT_ROOT
    directory = root / NAME
    archive_path = root / f"{NAME}.zip"
    assert directory.is_dir(), f"Missing package directory: {directory}"
    assert archive_path.is_file(), f"Missing package ZIP: {archive_path}"

    manifest_lines = (directory / "MANIFEST.sha256").read_text(encoding="utf-8").splitlines()
    checked = 0
    for line in manifest_lines:
        expected, relative = line.split("  ", 1)
        path = directory / relative
        assert path.is_file(), f"Manifest file missing: {relative}"
        assert sha256(path) == expected, f"Hash mismatch: {relative}"
        checked += 1

    with zipfile.ZipFile(archive_path) as archive:
        assert archive.testzip() is None, "ZIP CRC error"
        names = archive.namelist()
        assert names, "ZIP is empty"
        assert not any("__MACOSX" in name or "/._" in name or name.endswith(".DS_Store") for name in names)
        assert all(name.startswith(f"{NAME}/") for name in names)
        for name in names:
            name.encode("utf-8")

    summary = json.loads((directory / "inventory/inventory_summary.json").read_text(encoding="utf-8"))
    audit = json.loads((directory / "package_audit.json").read_text(encoding="utf-8"))
    assert audit["status"] == "PASS"
    assert audit["privacy_findings"] == []
    assert summary["installed_public_api_types"] >= 80
    assert summary["unique_menu_names"] >= 400
    assert "Core map" in summary["user_guide_categories"]
    assert "AI integration" in summary["user_guide_categories"]
    assert (directory / "real_example/移动App监管研究全景图.canvas").stat().st_size > 10_000
    assert (directory / "real_example/移动App监管研究全景图_高清渲染.png").stat().st_size > 500_000

    print(json.dumps({
        "status": "PASS",
        "manifest_files_checked": checked,
        "zip_members": len(names),
        "zip_bytes": archive_path.stat().st_size,
        "inventory": summary,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
