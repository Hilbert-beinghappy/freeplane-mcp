# Third-party notices and release status

The self-contained local installation includes these locked runtime packages:

| Package | Version | Declared license |
|---|---:|---|
| `@modelcontextprotocol/server` | 2.0.0 | MIT |
| `@modelcontextprotocol/core` | 2.0.0 | MIT |
| `zod` | 4.4.3 | MIT |

Their upstream `LICENSE` files are retained inside the installed package directories. `qualification/sbom.spdx.json` is the generated SPDX 2.3 inventory. Apple system frameworks are referenced by the macOS helper but are not redistributed.

Freeplane is supplied separately by the user and is not copied into the installation. The Java add-on binds to Freeplane APIs and qualified internal classes. Compatibility with Freeplane's licensing and any corresponding source/distribution obligations still requires written legal review before a formal release.

No license has been selected for the Freeplane MCP project itself. Public source visibility is not a grant of permission to copy, modify, or redistribute it. A formal release is blocked until the owner selects a project license and completes the required Freeplane/add-on legal review, notices, source headers, and notarization decision.
