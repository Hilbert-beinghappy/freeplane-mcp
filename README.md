# Freeplane MCP

Local-first MCP integration for Freeplane 1.13.3 on Apple Silicon macOS.

The Git repository lives at `/Volumes/huawei/项目实战/freeplane-mcp`. Because that volume is ExFAT, Node dependencies and temporary build/test work must use a local APFS cache directory.

The external review has been reconciled into the final implementation specification. The project has passed the **v0.0A evidence/compatibility**, **v0.0B bridge/transaction**, and **v0.1 read-only real-time MCP** gates.

## Current commands

```bash
npm run bootstrap
npm run qualify:v0.0a
npm run qualify:v0.0b
npm run qualify:v0.1
npm start
```

The v0.1 STDIO server exposes six qualified read-only tools: status, capabilities, map listing, paginated reads (including selection), bounded literal search, and revisioned changes. Live bridge responses can see unsaved edits; explicit saved-file fallback cannot. No map-write tool is registered before v0.2. See [docs/v0.0a.md](docs/v0.0a.md), [docs/v0.0b.md](docs/v0.0b.md), and [docs/v0.1.md](docs/v0.1.md).

The earlier consultation package can still be reproduced with:

```bash
python3 scripts/build_consultation_package.py
python3 scripts/verify_consultation_package.py
```
