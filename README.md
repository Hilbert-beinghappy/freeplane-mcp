# Freeplane MCP

Local-first MCP integration for Freeplane 1.13.3 on Apple Silicon macOS.

The Git repository lives at `/Volumes/huawei/项目实战/freeplane-mcp`. Because that volume is ExFAT, Node dependencies and temporary build/test work must use a local APFS cache directory.

The external review has been reconciled into the final implementation specification. The project has passed the gates through **v0.4 document lifecycle, export, and protected file writeback**.

## Current commands

```bash
npm run bootstrap
npm run qualify:v0.0a
npm run qualify:v0.0b
npm run qualify:v0.1
npm run qualify:v0.2
npm run qualify:v0.3
npm run qualify:v0.4
npm start
```

The v0.4 STDIO server exposes eleven qualified tools. It retains the v0.3 read/edit/organization surface and adds revision-guarded document lifecycle plus verified map-scope PNG/PDF/SVG/HTML export. Configured closed `.mm` files support lexical ordinary-node `TEXT` updates with APFS clone replacement and durable backups. Overwrite, dirty close, and revert require bound one-time confirmation. Node encryption and GUI automation remain unavailable. See [docs/v0.0a.md](docs/v0.0a.md), [docs/v0.0b.md](docs/v0.0b.md), [docs/v0.1.md](docs/v0.1.md), [docs/v0.3.md](docs/v0.3.md), and [docs/v0.4.md](docs/v0.4.md).

The earlier consultation package can still be reproduced with:

```bash
python3 scripts/build_consultation_package.py
python3 scripts/verify_consultation_package.py
```
