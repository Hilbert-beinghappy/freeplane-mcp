# Freeplane MCP

[English](README.md) | [简体中文](README.zh-CN.md)

A local-first MCP server that gives AI coding assistants structured, revision-safe access to Freeplane mind maps. Qualified for Freeplane 1.13.3 on Apple Silicon macOS.

The server communicates over STDIO using MCP protocol revision 2025-11-25. It connects to a running Freeplane instance through a token-authenticated local bridge, with file-based fallback for offline reads. Writes are revision-guarded and readback-verified; map edits are undoable as single compound units. There is no telemetry or public listener, and the local bridge is the only runtime network connection.

## Features

- Read live map trees with pagination, scoped subtrees, node selection, and literal search
- Apply atomic multi-operation edits with compound undo, rollback on failure, and idempotency keys
- Organize maps with clones, summaries, styles, layouts, clouds, bookmarks, formulas, and reminders
- Manage document lifecycle: create, open, save, save-as, close, revert with confirmation guards
- Export maps to PNG, PDF, SVG, or HTML with structural verification and atomic file placement
- Navigate presentations and toggle print preview through an allowlisted macOS Accessibility helper
- Monitor live change journals with cursor-based polling
- Fall back to direct XML file reads when Freeplane is not running
- Write node text to closed `.mm` files with backup retention and byte-level integrity checks

## MCP tools

The v1.0 surface exposes exactly twelve tools:

| Tool | Description |
|------|-------------|
| `freeplane_status` | Bridge connectivity, active map, degradation state, and recovery status |
| `freeplane_capabilities` | Frozen capability manifest from local qualification reports |
| `freeplane_list_maps` | Open maps via bridge, or configured saved maps when offline |
| `freeplane_read` | Paginated map snapshot with scope, depth, field projection, and selection |
| `freeplane_search` | Bounded literal text search across node trees |
| `freeplane_changes` | Cursor-based live event journal with optional long-poll |
| `freeplane_view` | Apply or clear a literal text filter on the active map view |
| `freeplane_apply` | Atomic compound edit with revision guard, readback, and confirmation |
| `freeplane_history` | Single undo or redo step with snapshot evidence |
| `freeplane_document` | Document create/open/save/save-as/close/revert lifecycle |
| `freeplane_export` | Map-scope export to PNG, PDF, SVG, or HTML |
| `freeplane_invoke_action` | Presentation navigation and print-preview open/close |

## Architecture

```
MCP Client (Claude, Codex, etc.)
    │ STDIO (JSON-RPC)
    ▼
freeplane-mcp server (Node.js 22)
    │
    ├── Bridge client ──► Freeplane add-on (127.0.0.1, ephemeral port, token auth)
    │                         └── Freeplane 1.13.3 (host-native, dedicated user dir)
    ├── File fallback ──► .mm XML on disk (read-only or qualified text writeback)
    └── AX helper ─────► macOS Accessibility (presentation/print-preview only)
```

The bridge binds only to localhost on an OS-assigned port. Discovery and token files are owner-readable only. The Accessibility helper is process-bound, locally signed, and never presses the final Print button.

## Prerequisites

- macOS on Apple Silicon (the only qualified platform)
- Freeplane 1.13.3 (exact qualified build)
- Node.js 22.x with npm 10+
- An APFS volume for Node dependencies and build caches. The source checkout itself may be on ExFAT; `npm run bootstrap` provisions the configured local cache.

## Installation (native, recommended)

Native installation is the primary path. It gives full access to all twelve tools, including the GUI actions that require the macOS Accessibility helper.

```bash
git clone https://github.com/Hilbert-beinghappy/freeplane-mcp.git
cd freeplane-mcp
npm run bootstrap
npm run install:local
npm run install:local -- --apply
```

The first `install:local` previews the installation plan. The second call with `--apply` executes it. The installer creates a dedicated Freeplane user directory and never modifies profile-wide script permissions.

By default, three executables are installed under `~/Library/Application Support/Freeplane-MCP/install/bin/`:

- `freeplane-mcp` — the STDIO MCP server process
- `freeplane-mcp-freeplane` — launches Freeplane with the bridge add-on active
- `freeplane-mcp-cli` — management CLI (`doctor`, `uninstall`, etc.)

### MCP client configuration

Point your MCP client at the installed server using an absolute path. For Claude Code `.mcp.json` or another JSON-based client:

```json
{
  "mcpServers": {
    "freeplane": {
      "command": "/Users/YOU/Library/Application Support/Freeplane-MCP/install/bin/freeplane-mcp",
      "args": []
    }
  }
}
```

For Codex `config.toml`:

```toml
[mcp_servers.freeplane]
command = "/Users/YOU/Library/Application Support/Freeplane-MCP/install/bin/freeplane-mcp"
args = []
```

Replace `/Users/YOU` with your macOS home directory. If you customized `FREEPLANE_MCP_HOME` or `--prefix`, use that installation prefix instead.

### Health verification

Start Freeplane through the dedicated launcher, then check the installation:

```bash
FREEPLANE_MCP_INSTALL="$HOME/Library/Application Support/Freeplane-MCP/install"
"$FREEPLANE_MCP_INSTALL/bin/freeplane-mcp-freeplane" &
"$FREEPLANE_MCP_INSTALL/bin/freeplane-mcp-cli" doctor
```

The `doctor` command verifies bridge connectivity, add-on version, Accessibility helper status, qualification report presence, and file-fallback configuration.

### Uninstall

Uninstall follows the same plan-then-apply pattern:

```bash
FREEPLANE_MCP_INSTALL="$HOME/Library/Application Support/Freeplane-MCP/install"
"$FREEPLANE_MCP_INSTALL/bin/freeplane-mcp-cli" uninstall
"$FREEPLANE_MCP_INSTALL/bin/freeplane-mcp-cli" uninstall --apply
```

## Installation (Docker, optional)

The Docker path runs only the Node.js MCP server process in a container. Freeplane, its Java add-on, and the macOS Accessibility helper remain on the host. No prebuilt image is published; you build locally from source.

This means presentation navigation and print-preview control are unavailable through Docker — those require the native installation.

```bash
git clone https://github.com/Hilbert-beinghappy/freeplane-mcp.git
cd freeplane-mcp
docker build -t freeplane-mcp:1.0.0 .
```

Complete the native installation first (so Freeplane and the bridge add-on are set up), then run the container with STDIO:

```bash
FREEPLANE_MCP_HOME="$HOME/Library/Application Support/Freeplane-MCP"
mkdir -p "$FREEPLANE_MCP_HOME/exports"

docker run --rm -i \
  --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=${FREEPLANE_MCP_HOME}/runtime,dst=/runtime" \
  --mount "type=bind,src=${FREEPLANE_MCP_HOME}/exports,dst=${FREEPLANE_MCP_HOME}/exports" \
  -e FREEPLANE_MCP_RUNTIME_DIR=/runtime \
  -e FREEPLANE_MCP_BRIDGE_HOST=host.docker.internal \
  -e "FREEPLANE_MCP_ALLOWED_ROOTS=[\"${FREEPLANE_MCP_HOME}/exports\"]" \
  freeplane-mcp:1.0.0
```

The host UID/GID preserves discovery-file ownership checks. The bridge host override routes to Docker Desktop's local gateway. The same-path exports mount lets both the container and host Freeplane verify exported artifacts.

## Development and qualification

```bash
npm run bootstrap          # Install locked dependencies
npm run build              # Compile TypeScript
npm test                   # Build helper, compile, run all tests
npm run test:addon         # Build and verify the Java bridge add-on
npm run qualify:v1.0       # Run the full v1.0 qualification gate
npm run doctor             # Check local installation health
```

Set `FREEPLANE_HOME` or `FREEPLANE_APP` if automatic bundle discovery does not work for your setup.

Historical qualification gates remain reproducible:

```bash
npm run qualify:v0.0a
npm run qualify:v0.0b
npm run qualify:v0.1
npm run qualify:v0.2
npm run qualify:v0.3
npm run qualify:v0.4
npm run qualify:v0.5
```

## Safety boundaries

The following are intentionally unavailable and rejected by schema or capability policy:

- Raw Freeplane action keys, menu paths, or arbitrary scripts
- Shell commands, coordinate-based input, or URL dispatch
- Public network listeners or external outbound connections
- Telemetry, uploads, or automatic Git/GitHub actions
- Destructive modal imports
- Node or map encryption (no qualified secure-input channel)
- Final print submission (preview only; the helper never presses Print)
- Conditional styles with executable expressions
- Reminder scripts

Destructive operations (node deletion, file overwrite, dirty close, revert) require a bound one-time confirmation tied to the plan, map, bridge instance, and revision.

Pending or indeterminate write outcomes block further writes until explicit readback reconciliation. See [docs/recovery.md](docs/recovery.md).

## Documentation

- [v1.0 installation and release boundary](docs/v1.0.md)
- [Compatibility notes](docs/compatibility.md)
- [Recovery procedures](docs/recovery.md)
- [Security policy](SECURITY.md)
- Qualification evidence: `qualification/reports/`
- Frozen capability table: `qualification/capabilities/capabilities.json`

## License

Freeplane MCP is released under the [MIT License](LICENSE). Runtime dependencies (`@modelcontextprotocol/server`, `@modelcontextprotocol/core`, `zod`) are also MIT-licensed.

A Docker image built from this repository contains only the Node.js MCP server and its locked dependencies. Freeplane is GPL-2.0 software installed separately by the user. The Java bridge add-on and macOS Accessibility helper are not included in the container image. Native macOS artifacts are locally qualified but not notarized.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the full distribution boundary.
