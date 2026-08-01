# Freeplane MCP

Local-first MCP integration for Freeplane 1.13.3 on Apple Silicon macOS.

The Git repository lives at `/Volumes/huawei/项目实战/freeplane-mcp`. Because that volume is ExFAT, Node dependencies and temporary build/test work must use a local APFS cache directory.

The external review has been reconciled into the final implementation specification. The project has passed the gates through **v0.3 knowledge organization and style**.

## Current commands

```bash
npm run bootstrap
npm run qualify:v0.0a
npm run qualify:v0.0b
npm run qualify:v0.1
npm run qualify:v0.2
npm run qualify:v0.3
npm start
```

The v0.3 STDIO server exposes nine qualified tools: six live/read-only tools, atomic apply/history, and literal view filtering. Atomic edits include the v0.2 core plus safe native styles/layout, free/side placement, content clones, summaries, clouds, bookmarks, bounded arithmetic formulas, and script-free reminders. Arbitrary CSS, scripts, conditional-style expressions, document writes, export, and GUI automation remain unavailable. See [docs/v0.0a.md](docs/v0.0a.md), [docs/v0.0b.md](docs/v0.0b.md), [docs/v0.1.md](docs/v0.1.md), and [docs/v0.3.md](docs/v0.3.md).

The earlier consultation package can still be reproduced with:

```bash
python3 scripts/build_consultation_package.py
python3 scripts/verify_consultation_package.py
```
