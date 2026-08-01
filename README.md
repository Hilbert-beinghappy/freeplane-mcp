# Freeplane MCP

Local-first MCP integration for Freeplane 1.13.3 on Apple Silicon macOS.

The Git repository lives at `/Volumes/huawei/项目实战/freeplane-mcp`. Because that volume is ExFAT, Node dependencies and temporary build/test work must use a local APFS cache directory.

The external review has been reconciled into the final implementation specification. The project has passed the **v0.0A evidence/compatibility gate** and the **v0.0B real-time bridge/transaction gate**.

## Current commands

```bash
npm run bootstrap
npm run qualify:v0.0a
npm run qualify:v0.0b
npm start
```

The current STDIO server still exposes only `freeplane_status` and `freeplane_capabilities`. v0.0B qualifies the isolated add-on bridge and its internal transaction path; it does not install the add-on or register an MCP map-write tool. See [docs/v0.0a.md](docs/v0.0a.md) and [docs/v0.0b.md](docs/v0.0b.md).

The earlier consultation package can still be reproduced with:

```bash
python3 scripts/build_consultation_package.py
python3 scripts/verify_consultation_package.py
```
