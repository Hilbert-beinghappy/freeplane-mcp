# Freeplane MCP execution plan

## Goal

Implement the frozen Freeplane MCP specification sequentially, keeping every unqualified capability unavailable.

## Phases

| Phase | Status | Exit condition |
|---|---|---|
| 0. Protect and initialize | complete | Repository exists at the user-selected project path; no user work overwritten |
| 1. Audit Freeplane and Codex automation surfaces | complete | Reproducible action/API inventory and cited automation evidence |
| 2. Build GPT Pro consultation package | complete | Redacted package contains prompt, brief, inventories, architecture, roadmap, tests, and real example |
| 3. Validate package | complete | Manifest hashes, ZIP test, filename/encoding checks, and content/privacy audit pass |
| 4. External GPT Pro review | complete | Complete decision specification returned |
| 5. Reconcile and freeze implementation spec | complete | Contracts, risk boundaries, and sequential gates frozen |
| 6A. v0.0A evidence and compatibility probe | complete | Exact build, classes, menu inventory, SDK/Codex STDIO handshake, and generated capability manifest pass |
| 6B. v0.0B transaction and real-time bridge | complete | Isolated Freeplane proves live unsaved reads, event reconciliation, rollback equivalence, and one-undo semantics |
| 7. v0.1 read-only real-time MCP | complete | Live list/read/selection/search/changes tools, file fallback, reconnect/full-resync, and 5,000-node latency gates pass |
| 8. v0.2 core atomic editing | complete | Qualified create/update/move/connector/fold/delete/undo/redo tools are one undo unit with zero partial writes |
| 9. v0.3 knowledge organization and style | complete | Qualified style/layout/summary/clone/filter/formula/reminder subset passes the 35-node/33-relation reconstruction gate |
| 10. v0.4 document lifecycle, export, and protection | complete | Qualified lifecycle/export/encryption/file-write routes pass conflict, artifact, XXE, and unknown-XML preservation gates |
| 11. v0.5 menu and macOS Accessibility | in_progress | Allow-listed GUI-only capabilities pass bilingual, focus, dialog-cancel, and postcondition qualification |
| 12. v1.0 local stable release | pending | Installer/uninstaller, diagnostics, recovery, compatibility matrix, docs, and complete qualification package pass clean-profile and restart gates |

## Locked decisions

- Goal-level coverage, not one MCP tool per Freeplane menu item.
- Local Codex STDIO only; no ChatGPT Pro runtime connection.
- TypeScript/Node 22 MCP plus a Freeplane Groovy/Java bridge and safe `.mm` fallback.
- Live state means fresh unsaved state on demand plus a revisioned change journal.
- Reversible edits may auto-run; destructive/overwriting/encryption/unsaved-close operations require confirmation.
- The repository is public at `Hilbert-beinghappy/freeplane-mcp`; the user authorized a dedicated commit and GitHub push after each remaining version passes its gate.
- v0.0 consultation is a hard gate before implementation.
- Repository source is stored at `/Volumes/huawei/项目实战/freeplane-mcp`; runtime dependencies and temporary build/test artifacts stay on local APFS because the repository volume is ExFAT.

## Errors encountered

| Error | Attempt | Resolution |
|---|---:|---|
| User-guide category extraction selected an inner tutorial node | 1 | Select the direct root map node and assert expected top-level categories |
| ExFAT AppleDouble files entered the first rebuilt ZIP | 1 | Filter metadata noise in manifest, privacy scan, ZIP creation, and verification |
| Freeplane script sandbox denied environment/process/permission APIs | 1 | Pass qualified runtime inputs explicitly, use the runtime MXBean PID, and pre-provision/verify runtime permissions in the isolated harness |
| Immediate Freeplane transaction commit left a deferred actor above the compound undo | 1 | Use Freeplane's native delayed commit/rollback and await transaction-level plus canonical-snapshot settlement |
| v0.1 qualification restart hook did not publish a replacement discovery record | 1 | Preserve the failed report, expose the isolated restart exception, and repair the lifecycle path before rerunning the full gate |
| Restart diagnostics showed Freeplane sandbox denied `modifyThread` on the old HTTP worker pool | 2 | Keep the qualification-only old daemon pool until the isolated process exits; still stop its listener, detach registry listeners, and start a fresh authenticated bridge |
| First `0.1.0` binary rerun degraded because the pre-gate manifest still pinned add-on `0.0.0-b` | 1 | Update only the runtime compatibility pin to `0.1.0`; capability statuses remain unchanged until the full rerun passes |
| Added EDT instrumentation measured a 170.39 ms first 5,000-node snapshot slice | 1 | Remove redundant recursive key sorting before snapshot hashing; capture maps already use deterministic insertion order and connectors are explicitly sorted |
| Final adversarial rerun measured a 106.54 ms cold snapshot after new checks | 1 | Cache repeated Freeplane node proxy lookups in the shared capture path; the next complete run measured 87.40 ms |
| Repeated Swing qualification hit Freeplane `focusOwner=null` on edit 11 | 1 | Make the isolated driver wait for a valid Swing focus owner before starting the next real editor action, then rerun the entire gate |
| Empty-list allocation optimization still called `sort()` on an immutable connector list | 1 | Sort only when at least two connectors exist; Java self-test and the full gate were rerun |
| Passive focus waiting could stall when isolated Freeplane never owned focus | 1 | Ask the isolated window and Freeplane map-view manager to recover focus before retrying the real editor action |
| Restored-mtime clearing was unstable across the file watcher and timestamp precision | 1 | Keep the contract-relevant delayed detection assertion; restore the temporary mtime without treating immediate clearing as a v0.1 gate |
| v0.2 redo rewrote volatile modified timestamps and left a metadata-only history entry | 1 | Exclude only volatile `timestamps.modified` from the logical snapshot hash, keep it fresh in reads, and skip bounded hash-invariant history noise inside one MCP history step |
| v0.3 bookmark fields overwrote the compiled operation discriminator | 1 | Compile the public bookmark type as `bookmark_type` and retain `type=set_bookmark` |
| Freeplane root-side runtime enum rejected `LEFT`/`RIGHT` aliases | 1 | Map the public contract to native `TOP_OR_LEFT`/`BOTTOM_OR_RIGHT` constants |
| Public bookmark mutation was not on Freeplane's undo stack | 1 | Wrap the native bookmark controller in one `IActor` inside the compound transaction |
| First v0.3 visual gate measured 37.88% section-heading overlap | 1 | Increase native per-section vertical shifts; the complete rerun measured 16% |
| Filter activity was inferred from the action, then from the wrong extension/object-presence test | 2 | Read the active filter through `FilterController`, use its native active-state predicate, and rerun the full gate |

## Current gate

v0.0A through v0.4 passed on the frozen Freeplane 1.13.3 build. Current gate: v0.5 menu and macOS Accessibility. The v0.4 server exposes exactly eleven tools; node encryption, executable conditional styles, raw CSS/scripts, and GUI automation remain unavailable.

## v0.4 high-risk execution boundary

- Goal: qualify revision-guarded document lifecycle, map-scope PNG/PDF/SVG/HTML export, and lexical closed-file text updates without risking user files.
- Scope: isolated Freeplane `-U` profiles and allowlisted temporary directories only during qualification; production calls require explicit allowed roots.
- Minimal routes: public lifecycle methods with deterministic internal default-template resolution, frozen internal export engines selected by stable implementation ID, and ordinary-node `TEXT` lexical patches only.
- Blast radius controls: no user profile, no user map, no arbitrary XML serialization, no symlink following, no raw action keys, no passwords in MCP input.
- Verification: conflict/confirmation/idempotency tests, artifact magic/dimensions/page count/parsing, XXE matrix, unknown-token byte equality, xattr preservation, backup evidence, save/reopen hashes, and isolated cleanup.
- Rollback: file patches keep original/candidate/manifest backups before same-directory replacement; export writes stage to a random sibling path before validation and rename.
- Explicit cut: node encryption remains unsupported until a qualified secret-input channel exists; ordinary MCP password fields are forbidden by the frozen specification.
