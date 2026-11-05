# Backup and restore

A backup contains the durable configuration snapshot, recovery journal, call
journal segments, and a SHA-256 manifest. It never contains the master key.
Keep the matching master key in an independent secret backup.

The default plugin cache (`<dataDir>/plugins`) is included with the data
directory. If `APPROVAL_MCP_PLUGINS_DIR` points elsewhere, back up that volume
separately. A restored state without its cache shows unavailable plugins;
use **Plugins → Repair installation** to retrieve the original pinned code.

The backup writer first asks the configuration store for a durable snapshot,
copies files to a private temporary directory, fsyncs them, writes checksums,
and atomically renames the completed directory. An existing destination is
never overwritten.

Always run a dry-run restore first. Dry-run validates every size and checksum
and replays the configuration store in a temporary directory. A real restore
must target a new, empty path while the server is stopped. After validation,
switch the configured data directory to the restored path and start the server.
Pending approvals are marked interrupted during startup and cannot execute.

Backups may be encrypted by the storage layer, but retaining plaintext backup
directories on shared disks is not recommended because call metadata and
configuration are operationally sensitive.
