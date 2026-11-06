# Backup and restore

A backup contains the durable configuration snapshot, recovery journal, call
journal segments, and a SHA-256 manifest. It never contains the master key.
Keep the matching master key in an independent secret backup.
For passkey-based storage, keep the independent storage recovery key as well.
Back up the **entire root volume**, not just `storage-v1/`: the vault manifest
and wrapping slots are essential. See [Encrypted storage](encrypted-storage.md).
If locked-start notifications are enabled, backups also contain their
delivery-only credentials outside the main vault; protect the backup itself.

The default plugin cache (`<dataDir>/plugins`) is included with the data
directory. If `APPROVAL_MCP_PLUGINS_DIR` points elsewhere, back up that volume
separately. A restored state without its cache shows unavailable plugins;
use **Plugins → Repair installation** to retrieve the original pinned code.

The backup writer first asks the configuration store for a durable snapshot,
copies files to a private temporary directory, fsyncs them, writes checksums,
and atomically renames the completed directory. An existing destination is
never overwritten.

Always run a dry-run restore first. Dry-run validates every size and checksum
and, with the matching key, replays the configuration store in a temporary
directory. Encrypted restores without a key report `decryptionValidated: false`
and validate only paths/sizes/checksums. A real restore
must target a new, empty path while the server is stopped. After validation,
switch the configured data directory to the restored path and start the server.
Pending approvals are marked interrupted during startup and cannot execute.

Active state/history are encrypted by the storage layer after migration.
Legacy backups, filesystem snapshots and any explicitly restored legacy
rollback directory can still contain plaintext. Do not retain those on shared
disks. An older image cannot directly read the migrated directory layout.
