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

## v0.0B implementation evidence

- The Java add-on bridge binds a dynamic `127.0.0.1` port, uses a 256-bit bearer token, writes atomic `0600` discovery under a `0700` runtime directory, rejects browser Origin requests, and dispatches Freeplane model access on Swing EDT.
- A real Swing inline-editor mutation was visible without saving in 204 ms and appeared in the revisioned change journal.
- The canonical snapshot covers map identity, node text/details/note, ordered children, attributes, tags, icons, style, fold state, and connectors with a 10,000-node/1,000-depth ceiling.
- A 100-operation mixed transaction committed and read back in 287.68 ms; one undo and one redo exactly matched the canonical before/after snapshots.
- Failure injection after each of 100 operations plus a postcondition failure restored transaction level and canonical snapshot equality with no recovery lock.
- Freeplane requires delayed transaction settlement so deferred EDT actors remain in the compound undo/rollback unit.
- Commit `e9d67f1` is pushed to the public GitHub repository on branch `codex/freeplane-mcp-v0`; anonymous HTTP access and the remote SHA were verified.

## v0.1 locked requirements

- Register exactly four new read-only MCP tools in addition to status/capabilities: `freeplane_list_maps`, `freeplane_read`, `freeplane_search`, and `freeplane_changes`; selection is a `freeplane_read` scope rather than a thirteenth tool.
- Live bridge authority must expose unsaved state; bridge loss degrades to explicit `authority=file` with `unsaved_visibility=false` and read-only `.mm` parsing only.
- Cursor embeds bridge instance plus global event sequence; restart mismatch and journal expiry require explicit full resync rather than guessed continuation.
- The v0.1 performance report must include p50, p95, max, cold/hot runs: status under 500 ms, 5,000-node read under 2 s, event visibility under 1 s, reconnect health under 2 s.
- `freeplane_read` needs bounded scopes/pagination and ordered duplicate attributes; `freeplane_search` accepts structured conditions only, with bounded regex or a conservative v0.1 literal-only subset.
- Map content is untrusted user data and must never be interpreted as configuration, scripts, tool parameters, or safety policy.
- File fallback is strictly read-only in v0.1 and must reject DTD, external entities, XInclude, malformed/unsupported encodings, oversized files/text/attribute sets, excessive XML depth or node count, symlinks, non-regular files, and paths outside configured allowlisted roots; successful responses include a SHA-256 revision and `unsaved_visibility=false`.
- The current npm graph has no XML parser dependency. A bounded streaming/token parser built on Node standard-library byte and string primitives is the smallest qualifying v0.1 route and avoids dependency/lockfile churn; file writes and lexical round-trip preservation remain gated to v0.4.
- Qualification must exercise literal structured search only for v0.1, cursor expiry/restart rejection, synthetic reconciliation, bounded journal memory, and isolated `-U` Freeplane operation; regex remains unavailable until a bounded implementation is qualified.
- Current compiled MCP tests intentionally assert the v0.0A two-tool surface. v0.1 needs a separate live/fallback qualifier and updated six-tool contract assertions without weakening the frozen v0.0A probe evidence.
- The existing bridge already provides authenticated `/v1/health`, `/v1/maps`, `/v1/read`, `/v1/search`, and `/v1/changes` routes with instance-bound cursors; the smallest v0.1 implementation is to harden/extend those routes and add a TypeScript adapter rather than create a second read model.
- The current STDIO server is a v0.0A probe shell: it always reports file authority, registers only status/capabilities, and has no bridge or XML fallback client. The v0.1 change must replace that static envelope path while preserving the two-tool probe report as baseline evidence.
- `MapRegistry` currently captures the entire map recursively on the Swing EDT every 250 ms and again on each read. That is adequate for the v0.0B one-node fixture but is the primary v0.1 large-map/UI-slice risk; benchmark before claiming the 5,000-node gate and reduce redundant captures if it misses.
- Existing bridge reads support only whole-map or one-node output, search only a case-insensitive text literal, and map summaries omit active/root/external-change fields. Selection IDs exist internally only for view events. v0.1 therefore needs bounded scope/pagination and summary enrichment in the shared registry rather than MCP-side post-filtering of unbounded snapshots.
- The event journal already enforces both 50,000-record and 64 MiB ceilings and returns `resync_required=true` details for expiry; its cursor codec rejects instance mismatches. These mechanisms should be tested directly, not reimplemented in TypeScript.
- Canonical nodes already preserve ordered duplicate attributes and include text/details/note/tags/icons/style/fold/connectors/children. v0.1 can paginate flattened node records derived from this existing snapshot while retaining the canonical snapshot hash/revisions.
- The frozen contract names no direct `file_path` argument for `freeplane_read`. File fallback will therefore expose only explicitly configured `.mm` files as stable `file:<sha256(canonical-path)>` map IDs through `freeplane_list_maps`, then accept those IDs in read/search. This preserves the 12-tool surface and keeps arbitrary filesystem paths out of tool calls.
- Discovery includes instance ID, PID, process start, loopback host/port, bearer token, Freeplane/build/add-on versions, and expiry. The host adapter must validate every field, permissions, PID liveness, expiry, loopback binding, qualified build fingerprint, and health response before treating it as bridge authority.
- The public `MindMap` API exposes saved/dirty state but no already-qualified external-change/read-only summary surface. v0.1 will report those fields conservatively (`read_only=false` only for the live public-API route; `external_change=false` only when the current file identity matches the captured one) and leave unsupported certainty explicit rather than infer it.
- First v0.1 live qualification passed 11 checks before the reconnect gate: status p95 2.74 ms, 5,000-node read p95 94.99 ms, GUI event p95 850.14 ms, 50,000 retained events at 15,988,858 bytes, pagination/selection/search/synthetic reconciliation/cursor expiry all passed. The isolated in-process restart failed to publish replacement discovery and must be diagnosed; no performance or read contract failed.
- The exposed restart exception is exact: Freeplane's script security manager denied `RuntimePermission("modifyThread")` when the qualification restart thread called `ThreadPoolExecutor.shutdownNow`. The fix is confined to the qualification-only restart path; the old listener and registry still stop, while its two daemon workers are reclaimed when the isolated process exits.
- Final binary-matched v0.1 qualification passed 18 checks with add-on/server `0.1.0`: status p95 2.59 ms, 5,000-node read p95 45.06 ms, maximum EDT snapshot slice 82.47 ms, GUI event p95 945.48 ms, reconnect 228.13 ms, and the bounded 50,000-event journal increased Freeplane RSS by 212,992 bytes in the final run. The authoritative report is `qualification/reports/v0.1-local.json`.
- Capability inspection is derived from the registered v0.1 surface: qualified read capabilities report `available_via_mcp=true`, while v0.0B edit internals remain false until v0.2 registers and requalifies them. Status now reports the v0.1 qualification ID rather than the bootstrap v0.0A probe ID.
- Saved-file identity is transition-aware: polling preserves the baseline while a map remains saved, detects an external file stamp change, and advances the baseline only on a dirty-to-saved transition.

## v0.2 implementation evidence

- The public MCP surface is exactly eight tools: the six qualified v0.1 reads plus `freeplane_apply` and `freeplane_history`; unqualified v0.3 operations are rejected by the protocol and bridge operation allowlists.
- `freeplane_apply` supports a strict bounded operation union for create/content/attributes/tags/icons/links/move/reorder/fold/connectors/delete, with revision checks, normalized dry-run plans, postcondition readback, one-time destructive confirmation, and UUID idempotency.
- The bridge validates the complete virtual tree before mutation, executes one Freeplane compound transaction, resolves temporary node IDs, verifies every operation, and returns no normal partial-success state.
- The final isolated gate passed all 27 checks: the inherited v0.1 evidence hash, 16/16 injected core failure points, every connector/delete failure point, exact undo/redo, confirmation binding, idempotency replay, private ledger, and unchanged fixture checks all passed.
- Ten real 100-operation commits measured p50 137.27 ms and p95/max 199.21 ms, below the 2,000 ms gate.
- Freeplane rewrites `timestamps.modified` during redo and may record a metadata-only history item. Logical snapshot hashes exclude only this volatile field while read responses retain its current value; one MCP history step skips at most eight hash-invariant metadata entries before returning verified logical readback.
- Idempotency state is atomic `0600` under a `0700` runtime directory, bounded to 10,000 entries/24 hours, stores payload hashes and result envelopes rather than request content, and leaves uncertain outcomes pending for reconciliation.

## v0.3 implementation evidence

- The MCP surface is exactly nine tools: the v0.2 surface plus revision-guarded literal `freeplane_view` filtering.
- The qualified atomic subset covers safe native style/layout, root side and free placement, content clones without subtrees, native summaries, clouds, bookmarks, arithmetic-only formulas, and script-free reminders.
- Public bookmark mutation bypasses Freeplane's undo stack, so the bridge wraps the native bookmark controller in an `IActor`; all 28/28 injected organization failure points then restored canonical equality.
- The isolated synthetic research map passed the frozen 35-node/33-relation gate, exact five H2 updates, five distinct section styles, native summary/clone readback, and one undo/redo equality.
- Swing component bounds measured a worst section-heading overlap ratio of 0.16 after native spacing adjustment, below the 0.20 severe-overlap gate.
- Conditional-style expressions, raw CSS, reminder scripts, and arbitrary formulas remain explicitly unsupported rather than being passed through as executable strings.
- Version qualification is aggregate: a v0.3 capability downgrade removes the organization tool and makes `qualification_passed=false`; literal-filter activity is read from Freeplane's native filter controller rather than inferred from the requested action.

## v0.4 implementation evidence

- The MCP surface is exactly eleven tools: the v0.3 surface plus `freeplane_document` and `freeplane_export`; v0.4 qualification is aggregate over inherited read, write, organization, and document capabilities.
- Lifecycle qualification covers deterministic chooser-free create, create from template, open, save, confirmed save-as overwrite, cancel, confirmed save-then-close, confirmed discard-then-close, and confirmed revert with registry and file-hash readback.
- Native PNG/PDF/SVG/static-HTML exporters are selected by stable implementation identity. Vector output waits for bounded stable completion; every staged artifact is format-checked, hashed, and atomically published, with a durable backup before overwrite.
- Closed-file writeback accepts only ordinary-node `TEXT` changes on configured files not open in Freeplane. The final gate preserved BOM, comments, namespaces, unknown attributes/elements, xattrs, and every byte outside the selected values while retaining original/candidate/manifest backups.
- The hostile matrix rejects DTD/XXE, symlinks, and outside-root paths before Freeplane. Node encryption remains `unsupported` because ordinary MCP parameters are not a secure secret-input channel.
- The final isolated gate passed 26/26 checks and preserved the pre-existing Freeplane PID 43117 exactly.

## v0.5 implementation evidence

- The MCP surface is exactly twelve tools: the v0.4 surface plus one goal-level `freeplane_invoke_action` tool. Its schema accepts only the project-owned `presentation.navigate` and `print.preview` capability/action enums.
- The minimal ad-hoc-signed Swift helper binds the request to bundle `org.freeplane.launcher`, the bridge-reported PID, an identifiable main window, and exact English or Simplified Chinese AX menu titles. It accepts no raw action key, menu path, AX query, script, shell command, or coordinate.
- Presentation state is created and read through the in-process bridge. Start, stop, first, previous, next, and last each require revision preconditions and a deterministic bridge postcondition; print preview requires AX window appearance and close-button cancellation readback.
- macOS global-menu focus changes, hidden background menus, and rendered Chinese mnemonic suffixes were observed directly. The helper now uses system-wide AX focus PID state, selects one path from the authenticated bridge locale, reports background dry-run resolution as deferred, and strips only a terminal one-character mnemonic before actual exact-title comparison.
- The final bilingual isolated gate passed 30/30 checks. Both locales passed dry-run zero effect, focus recovery, idempotent replay, six presentation transitions, preview open/cancel, stale-revision and arbitrary-input rejection, zero content mutation, private logs, helper signature verification, and exact preservation of Freeplane PID 43117.
- Destructive imports, node/map encryption, final printing, preferences, and other modal workflows remain explicitly unsupported because no secure input plus deterministic cancellation/postcondition path qualified.
