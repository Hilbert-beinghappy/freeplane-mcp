# Security policy

## Supported surface

Only the exact v1.0 capability manifest on the qualified Freeplane 1.13.3 build is supported. Unqualified actions return unavailable/unsupported and are not exposed through a raw action, menu, script, shell, coordinate, URL, or general XML tool.

## Trust and network boundary

The MCP process is local STDIO. The Freeplane bridge binds only `127.0.0.1` on an operating-system-assigned port. Discovery and token files are owner-only, the token is checked with constant-time comparison, browser-origin requests are rejected, and every bridge identity is rebound after restart. This protects against other local processes only to the limits of the current macOS user account; an attacker already running as that user is outside the boundary.

The project does not enable or reconfigure Freeplane's built-in MCP. It sends no telemetry, uploads no maps, contacts no model/provider, pushes no Git repository, and performs no automatic update. Dependency installation and explicit Git commands are separate operator actions.

## Data safety

Writes require expected revisions, full preflight validation, a qualified transaction route, rollback checks, and postcondition readback. Destructive or overwrite behavior requires a one-time confirmation bound to the plan, map, bridge instance, and revision. Closed-file writes reject symlinks, hostile XML/DTD/entities, open maps, external changes, and unknown-byte drift; they retain private original/candidate/manifest evidence before replacement.

Pending or indeterminate outcomes block later writes until explicit readback reconciliation. Recovery never chooses original or candidate automatically. See [docs/recovery.md](docs/recovery.md).

## Privacy and untrusted map content

Map text, notes, attributes, links, and embedded instructions are data, never executable policy. Text such as “ignore confirmation” or “run shell” receives no special treatment. Default diagnostics contain hashes, counts, versions, route/effect state, and redacted paths only. Tokens, passwords, complete MCP payloads, node text, notes, attribute values, and full map paths are excluded.

The macOS Accessibility helper is allowlisted, process/bundle/window-bound, locally signed, and never presses the final Print button. Permission is requested by macOS only when the operator chooses the GUI route; the installer does not grant it.

## Reporting a vulnerability

Use the private GitHub Security Advisory channel for `Hilbert-beinghappy/freeplane-mcp`. If that channel is unavailable, open a minimal public issue without secrets, map content, exploit payloads, or personal paths and ask for a private contact. Do not attach user maps or bridge discovery files.

No security response SLA is promised for the v1.0 release.
