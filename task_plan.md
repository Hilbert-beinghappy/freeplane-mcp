# Freeplane MCP execution plan

## Goal

Build the verified GPT Pro consultation package first, then freeze and implement the MCP only after the external planning response is returned and reconciled with local Freeplane 1.13.3 evidence.

## Phases

| Phase | Status | Exit condition |
|---|---|---|
| 0. Protect and initialize | complete | Repository exists at the user-selected project path; no user work overwritten |
| 1. Audit Freeplane and Codex automation surfaces | complete | Reproducible action/API inventory and cited automation evidence |
| 2. Build GPT Pro consultation package | complete | Redacted package contains prompt, brief, inventories, architecture, roadmap, tests, and real example |
| 3. Validate package | complete | Manifest hashes, ZIP test, filename/encoding checks, and content/privacy audit pass |
| 4. External GPT Pro review | pending_external | User uploads package and returns the complete response |
| 5. Reconcile and freeze implementation spec | pending | External advice is checked against local evidence; contracts and gates frozen |
| 6. Implement v0.1-v1.0 | pending | Version gates pass sequentially; no remote publication without approval |

## Locked decisions

- Goal-level coverage, not one MCP tool per Freeplane menu item.
- Local Codex STDIO only; no ChatGPT Pro runtime connection.
- TypeScript/Node 22 MCP plus a Freeplane Groovy/Java bridge and safe `.mm` fallback.
- Live state means fresh unsaved state on demand plus a revisioned change journal.
- Reversible edits may auto-run; destructive/overwriting/encryption/unsaved-close operations require confirmation.
- Local stability first; open-source publication is a later separately authorized action.
- v0.0 consultation is a hard gate before implementation.
- Repository source is stored at `/Volumes/huawei/项目实战/freeplane-mcp`; runtime dependencies and temporary build/test artifacts stay on local APFS because the repository volume is ExFAT.

## Errors encountered

| Error | Attempt | Resolution |
|---|---:|---|
| User-guide category extraction selected an inner tutorial node | 1 | Select the direct root map node and assert expected top-level categories |
| ExFAT AppleDouble files entered the first rebuilt ZIP | 1 | Filter metadata noise in manifest, privacy scan, ZIP creation, and verification |

## Current gate

v0.0 is complete. Work must remain at Phase 4 until the user returns GPT Pro's complete response; v0.1 implementation before that would violate the agreed external-review gate.
