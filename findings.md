# Findings

## Verified environment

- Freeplane 1.13.3 is installed at `/Applications/Freeplane.app` on Apple Silicon.
- Bundled runtime is OpenJDK 21; local Node is 22.17.1 and npm is 10.9.2.
- Codex supports local STDIO MCP servers configured in user or project `config.toml`.
- The repository lives at `/Volumes/huawei/项目实战/freeplane-mcp` on ExFAT; Node dependencies and temporary build/test work will use local APFS storage.

## Verified Freeplane automation surfaces

- Launcher supports `-R<file>` for scripts, `-X<menukey>` for menu actions, `-S` shutdown, `-N` noninteractive, and `-U<userdir>`.
- Installed documentation exposes 81 public API type pages after excluding package index pages.
- Across the four installed menu XML files, the reproducible inventory contains 1,142 rows, 505 unique menu names, and 381 unique action names.
- The built-in user guide groups functions into core maps, moving/grouping, links/bookmarks, formatting/styles, filtering/search, presentation, publishing, extensions, notes/tags, calculations, reminders, protection, code explorer, settings, and AI integration.
- Official scripting supports node creation/mutation, connectors, move operations, add-ons, startup scripts, and scripted export.

## Product boundary

- A model cannot continuously think between turns. The bridge will journal changes continuously; Codex will read current unsaved state and changes when tools are called.
- Public scripting APIs will be preferred; allow-listed menu actions are secondary; macOS Accessibility is a later fallback for GUI-only goals.

## v0.0 deliverable evidence

- Consultation ZIP contains 18 members and 17 manifest-hashed content files plus the manifest.
- Privacy scan found zero forbidden local paths, credentials, raw regulatory data, or paper files.
- ZIP excludes ExFAT AppleDouble and `.DS_Store` metadata.
- ZIP SHA-256: `e164ca9568597b770a009191c4e49a264cb55e8aae757566c61b1e808910aeb5`.

## v0.0A implementation evidence

- Frozen implementation specification SHA-256: `a8e61e606556cd02e10bf2e80a29cdc6e320bff2dbcb07b48c2d5d86f57beddf`.
- Frozen Freeplane build fingerprint: `ff6dab76e60acfb0666ee8ac90dcf2df5bbb1975c2d99eab59ca3f08dcda1822` across ten bundle artifacts.
- Freeplane's bundled Java is 21.0.11; the interactive shell Java is not used for qualification.
- Required public APIs and internal transaction methods are present, but remain `needs_validation` until exercised in-process.
- The built-in Freeplane MCP is present, disabled by default, not listening on port 6298, and advertises protocol revision `2024-11-05`; its token was not read.
- The server is pinned to MCP `2025-11-25`. Both the official SDK client and the local Codex app-server initialized it, listed its two read-only tools, and called `freeplane_status` successfully.
- The actual Codex host test uses an isolated temporary `CODEX_HOME` and an ephemeral thread; it does not start a model turn or alter global Codex configuration.
