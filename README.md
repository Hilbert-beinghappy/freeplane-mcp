# Freeplane MCP

Local-first MCP integration for Freeplane 1.13.3 on Apple Silicon macOS.

The Git repository lives at `/Volumes/huawei/项目实战/freeplane-mcp`. Because that volume is ExFAT, Node dependencies and temporary build/test work must use a local APFS cache directory.

The project is currently at the **v0.0 external planning gate**. The first deliverable is a verified, privacy-bounded consultation package for GPT Pro. MCP implementation begins only after that response is returned and reconciled with local Freeplane evidence.

## Current commands

```bash
python3 scripts/build_consultation_package.py
python3 scripts/verify_consultation_package.py
```

The scripts use only the Python standard library. The later MCP implementation remains fixed to TypeScript/Node.js 22 with the official MCP SDK.
