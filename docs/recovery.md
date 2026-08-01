# Recovery manual

Freeplane MCP never chooses a recovery outcome automatically. Inspect first, read the displayed hashes, then issue a separate hash-bound command.

For a closed-map backup:

```bash
freeplane-mcp-cli recover inspect --backup /absolute/backup/id --target /absolute/map.mm
freeplane-mcp-cli recover restore-original --backup /absolute/backup/id --target /absolute/map.mm --expected-target-sha256 HASH
freeplane-mcp-cli recover restore-original --backup /absolute/backup/id --target /absolute/map.mm --expected-target-sha256 HASH --apply
```

Use `apply-candidate` instead of `restore-original` only when the retained candidate is the intended state. Use `missing` as the expected target value only when inspection reports `target_missing`. An artifact backup retains the original but not a second candidate, so only `restore-original` is available.

The apply step rechecks the target hash, preserves any existing target bytes inside the private backup directory, writes a same-directory temporary file, renames atomically, and verifies the resulting hash. A symlink, changed target, corrupt manifest, invalid evidence hash, or unqualified filesystem stops recovery.

An MCP process crash can leave a private idempotency entry pending. First perform a full `freeplane_read` and record its returned snapshot hash. Then inspect and reconcile:

```bash
freeplane-mcp-cli recover ledger --runtime-dir /absolute/runtime
freeplane-mcp-cli recover reconcile-ledger --runtime-dir /absolute/runtime --key UUID --payload-sha256 PAYLOAD_HASH --readback-sha256 SNAPSHOT_HASH
freeplane-mcp-cli recover reconcile-ledger --runtime-dir /absolute/runtime --key UUID --payload-sha256 PAYLOAD_HASH --readback-sha256 SNAPSHOT_HASH --apply
```

Reconciliation records the observed readback and permanently retires that idempotency key; retry with a new key. While a pending entry or map-level recovery flag exists, writes remain blocked. Freeplane memory that was never saved cannot be reconstructed by this tool.
