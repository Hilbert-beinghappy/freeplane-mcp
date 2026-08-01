# Compatibility matrix

The v1.0 local-stable claim is intentionally narrow.

| Component | Qualified | Status |
|---|---|---|
| Freeplane | 1.13.3, bundle `org.freeplane.launcher`, fingerprint `ff6dab76e60acfb0666ee8ac90dcf2df5bbb1975c2d99eab59ca3f08dcda1822` | Supported exactly |
| Freeplane Java | Bundled Java 21.0.11 | Supported exactly |
| Node.js | 22.x; final qualification used 22.17.1 | Supported |
| MCP protocol | 2025-11-25 | Supported exactly |
| MCP TypeScript SDK | 2.0.0 | Locked |
| Zod | 4.4.3, one runtime copy | Locked |
| macOS | 26.5.2 build 25F84, arm64 | Qualified |
| Apple Silicon | arm64 | Qualified |
| Intel macOS | — | Unverified |
| Linux / Windows | — | Unverified; do not infer support from portable TypeScript code |
| GUI helper | macOS Accessibility, ad-hoc signed | Qualified locally; not notarized |
| Filesystem replacement/recovery | APFS local volume | Qualified |
| SMB, NFS, cloud placeholders | — | Unsupported for write/recovery routes |

Set `FREEPLANE_HOME` or `FREEPLANE_APP` to a custom absolute app-bundle path. Build, install, diagnostic, and qualification code discovers the bundle by identifier when neither is set. Runtime, installation prefix, and dedicated Freeplane user directory are independently configurable.

Any change to the Freeplane build fingerprint, add-on version, helper binary, protocol revision, dependency lock, architecture, or operating system requires requalification before support can be claimed.
