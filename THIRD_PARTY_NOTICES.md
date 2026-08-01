# Third-party notices and distribution status

Freeplane MCP is released under the MIT License; see `LICENSE`.

The self-contained local installation includes these locked runtime packages:

| Package | Version | Declared license |
|---|---:|---|
| `@modelcontextprotocol/server` | 2.0.0 | MIT |
| `@modelcontextprotocol/core` | 2.0.0 | MIT |
| `zod` | 4.4.3 | MIT |

Their upstream `LICENSE` files are retained inside the installed package directories. `qualification/sbom.spdx.json` is the generated SPDX 2.3 inventory. A Docker image built from this repository contains the Node MCP process, these runtime dependencies, this notice, and the project license. Apple system frameworks are referenced by the macOS helper but are not redistributed.

Freeplane is GPL-2.0 software supplied separately by the user. It is not copied into the Docker image. The Java add-on binds to Freeplane APIs and qualified internal classes, but neither its binary nor the macOS Accessibility helper is included in the image.

The owner chose source-only Docker distribution on 2026-08-02; no prebuilt image is published. A bundled native distribution that includes the Java add-on or macOS helper remains a separate release boundary and still requires Freeplane/add-on license review, complete notices/source obligations, and an explicit notarization decision.
