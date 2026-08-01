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

## Docker / GHCR deployment

The public image supports `linux/amd64` and `linux/arm64`:

```bash
docker pull ghcr.io/hilbert-beinghappy/freeplane-mcp:1.0.0
```

Use the pinned version tag for deployment. `latest` points to the current stable version.

Freeplane and its bridge add-on continue to run natively on the macOS host. First complete the [local installation](#local-install), launch Freeplane through `freeplane-mcp-freeplane`, and keep Docker Desktop running. Then start the STDIO server with the same macOS UID/GID that owns the private bridge discovery file:

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
  ghcr.io/hilbert-beinghappy/freeplane-mcp:1.0.0
```

An MCP client should run that command with a persistent STDIO pipe. For Codex, replace `501:20` and `/Users/YOU` below with the values from `id -u`, `id -g`, and your home directory:

```toml
[mcp_servers.freeplane]
command = "docker"
args = [
  "run", "--rm", "-i",
  "--user", "501:20",
  "--mount", "type=bind,src=/Users/YOU/Library/Application Support/Freeplane-MCP/runtime,dst=/runtime",
  "--mount", "type=bind,src=/Users/YOU/Library/Application Support/Freeplane-MCP/exports,dst=/Users/YOU/Library/Application Support/Freeplane-MCP/exports",
  "-e", "FREEPLANE_MCP_RUNTIME_DIR=/runtime",
  "-e", "FREEPLANE_MCP_BRIDGE_HOST=host.docker.internal",
  "-e", "FREEPLANE_MCP_ALLOWED_ROOTS=[\"/Users/YOU/Library/Application Support/Freeplane-MCP/exports\"]",
  "ghcr.io/hilbert-beinghappy/freeplane-mcp:1.0.0"
]
```

The same-path exports mount lets both the container and host Freeplane verify exported files. The host UID/GID preserves the discovery-file ownership check, and the bridge host override accepts only Docker Desktop's local gateway. The Linux image does not contain Freeplane, the Java add-on, or the macOS Accessibility helper. Presentation navigation and print-preview control therefore remain available only through the native MCP process.

To build the same image from source:

```bash
docker build -t freeplane-mcp:1.0.0 .
```

## Local install

Install Freeplane 1.13.3 and Node.js 22 first. Then clone the repository, bootstrap its locked dependencies, review the default installation plan, and apply it explicitly:

```bash
git clone https://github.com/Hilbert-beinghappy/freeplane-mcp.git
cd freeplane-mcp
npm run bootstrap
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

Freeplane MCP is released under the [MIT License](LICENSE). The GHCR image redistributes only the Node MCP process and its locked MIT dependencies; Freeplane remains a separate GPL-2.0 installation. Native macOS artifacts are locally qualified but not notarized. See [third-party notices and distribution boundaries](THIRD_PARTY_NOTICES.md).
