# Freeplane MCP

Local-first MCP integration for the exact qualified Freeplane 1.13.3 build on Apple Silicon macOS.

The v1.0 local-stable surface has twelve goal-level tools for live reads, revisioned changes, atomic editing/history, knowledge organization, document lifecycle, verified export, limited closed-file text writeback, and allowlisted presentation/print-preview control. Raw action keys, arbitrary scripts or shell commands, coordinates, public listeners, uploads, automatic Git/GitHub actions, destructive imports, encryption, and final printing are unavailable.

## Develop and qualify

```bash
npm run bootstrap
npm test
npm run test:addon
npm run qualify:v1.0
```

Set `FREEPLANE_HOME` or `FREEPLANE_APP` when bundle discovery is not appropriate. Node dependencies and build caches must be on an APFS volume; `npm run bootstrap` provisions the repository's configured local cache when the source checkout is on ExFAT.

Historical gates remain reproducible with `npm run qualify:<version>` for `v0.0a`, `v0.0b`, `v0.1`, `v0.2`, `v0.3`, `v0.4`, and `v0.5`.

## Local install

Review the default plan, then apply it explicitly:

```bash
npm run install:local
npm run install:local -- --apply
```

The installer uses a dedicated Freeplane user directory and never changes profile-wide script permissions. Launch Freeplane through the installed `bin/freeplane-mcp-freeplane`, configure Codex to run `bin/freeplane-mcp` over STDIO, and inspect the installation with `bin/freeplane-mcp-cli doctor`.

Uninstall is also plan-first:

```bash
bin/freeplane-mcp-cli uninstall
bin/freeplane-mcp-cli uninstall --apply
```

See [v1.0 installation and release boundary](docs/v1.0.md), [compatibility](docs/compatibility.md), [recovery](docs/recovery.md), and [security policy](SECURITY.md). Qualification evidence lives under `qualification/reports/`; the frozen runtime table is `qualification/capabilities/capabilities.json`.

## Licensing status

This repository is publicly visible, but no project license has been selected. v1.0 is a qualified local build, not a formal redistributable or notarized release. See [third-party notices and remaining legal gate](THIRD_PARTY_NOTICES.md).
