# Freeplane MCP

Local-first MCP integration for Freeplane 1.13.3 on Apple Silicon macOS.

The Git repository lives at `/Volumes/huawei/项目实战/freeplane-mcp`. Because that volume is ExFAT, Node dependencies and temporary build/test work must use a local APFS cache directory.

The external review has been reconciled into the final implementation specification. The project has passed the gates through **v0.5 allowlisted presentation and print-preview automation**.

## Current commands

```bash
npm run bootstrap
npm run qualify:v0.0a
npm run qualify:v0.0b
npm run qualify:v0.1
npm run qualify:v0.2
npm run qualify:v0.3
npm run qualify:v0.4
npm run qualify:v0.5
npm start
```

The v0.5 STDIO server exposes twelve qualified tools. It retains the v0.4 read/edit/organization/document/export surface and adds `freeplane_invoke_action` for six presentation-navigation actions plus print-preview open/close. A minimal ad-hoc-signed Swift helper binds every call to the exact Freeplane bundle, process, window, capability, and localized menu path; Accessibility permission is required only for this GUI route. Raw action keys, menu paths, scripts, shell commands, coordinates, destructive imports, map encryption, final printing, and preferences remain unavailable. See [docs/v0.0a.md](docs/v0.0a.md), [docs/v0.0b.md](docs/v0.0b.md), [docs/v0.1.md](docs/v0.1.md), [docs/v0.3.md](docs/v0.3.md), [docs/v0.4.md](docs/v0.4.md), and [docs/v0.5.md](docs/v0.5.md).

The earlier consultation package can still be reproduced with:

```bash
python3 scripts/build_consultation_package.py
python3 scripts/verify_consultation_package.py
```
